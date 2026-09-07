from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from backend.config import Settings
from backend.database import Database
from backend.watcher import RetryPoll, Watcher


class FakeSource:
    def __init__(self, frame: pd.DataFrame):
        self.frame = frame
        self.fail_history_once = False

    def connect(self) -> None:
        return None

    def close(self) -> None:
        return None

    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame:
        if count > 2 and self.fail_history_once:
            self.fail_history_once = False
            raise RuntimeError("simulated history failure")
        return self.frame.tail(count).copy()


class FakePush:
    def broadcast_alert(self, alert: dict) -> dict[str, int]:
        raise AssertionError("_poll_timeframe should return pending pushes, not perform network I/O")


def _settings(directory: str, **overrides):
    base = dict(
        data_source="demo",
        data_dir=Path(directory),
        timeframes=(10,),
        history_bars=150,
        min_history_bars=100,
        catch_up_max_age_seconds=900,
        bar_close_grace_seconds=3600,
        alert_directions=("bullish", "bearish"),
    )
    base.update(overrides)
    return replace(Settings.from_env(), **base)


def _flat_then(last_close: float, boundary: pd.Timestamp, periods: int = 120) -> pd.DataFrame:
    times = pd.date_range(end=boundary - pd.Timedelta(minutes=10), periods=periods, freq="10min", tz="UTC")
    return pd.DataFrame({"time": times, "close": [100.0] * (periods - 1) + [last_close]})


class WatcherTests(unittest.TestCase):
    def test_forming_candle_is_ignored_then_processed_after_next_bar_opens(self) -> None:
        boundary = pd.Timestamp.now(tz="UTC").floor("10min")
        source = FakeSource(_flat_then(120.0, boundary))

        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "watcher.sqlite3")
            watcher = Watcher(_settings(directory), database, source, FakePush())  # type: ignore[arg-type]

            # The sharp final value is still forming, so startup seeds the candle
            # before it and deliberately emits nothing.
            self.assertEqual(watcher._poll_timeframe(10), [])

            source.frame = pd.concat(
                [source.frame, pd.DataFrame({"time": [boundary], "close": [141.0]})],
                ignore_index=True,
            )
            pending = watcher._poll_timeframe(10)

            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["direction"], "bullish")
            self.assertTrue(pending[0]["id"].endswith(":bullish"))
            self.assertEqual(pending[0]["bar_open"], (boundary - pd.Timedelta(minutes=10)).isoformat().replace("+00:00", "Z"))
            self.assertGreater(pending[0]["histogram"], 0)
            self.assertEqual(len(database.list_alerts()), 1)
            self.assertEqual(database.outbox_pending_count(), 1)

    def test_bearish_cross_is_detected_and_can_be_filtered_out(self) -> None:
        boundary = pd.Timestamp.now(tz="UTC").floor("10min")
        for directions, expected in ((("bullish", "bearish"), 1), (("bullish",), 0)):
            source = FakeSource(_flat_then(80.0, boundary))
            with tempfile.TemporaryDirectory() as directory:
                database = Database(Path(directory) / "watcher.sqlite3")
                watcher = Watcher(
                    _settings(directory, alert_directions=directions), database, source, FakePush()  # type: ignore[arg-type]
                )
                self.assertEqual(watcher._poll_timeframe(10), [])
                source.frame = pd.concat(
                    [source.frame, pd.DataFrame({"time": [boundary], "close": [79.0]})], ignore_index=True
                )
                pending = watcher._poll_timeframe(10)
                self.assertEqual(len(pending), expected, directions)
                if expected:
                    self.assertEqual(pending[0]["direction"], "bearish")
                    self.assertTrue(pending[0]["id"].endswith(":bearish"))
                    self.assertLess(pending[0]["histogram"], 0)

    def test_failed_history_fetch_does_not_mark_bar_observed(self) -> None:
        boundary = pd.Timestamp.now(tz="UTC").floor("10min")
        frame = pd.DataFrame({
            "time": pd.date_range(end=boundary, periods=120, freq="10min", tz="UTC"),
            "close": [100.0] * 120,
        })
        source = FakeSource(frame)
        source.fail_history_once = True
        with tempfile.TemporaryDirectory() as directory:
            watcher = Watcher(
                _settings(directory), Database(Path(directory) / "watcher.sqlite3"), source, FakePush()  # type: ignore[arg-type]
            )
            with self.assertRaisesRegex(RuntimeError, "simulated history failure"):
                watcher._poll_timeframe(10)
            self.assertNotIn(10, watcher._observed_current_bar)
            self.assertEqual(watcher._poll_timeframe(10), [])
            self.assertIn(10, watcher._observed_current_bar)

    def test_short_history_is_a_retry_not_a_signal(self) -> None:
        boundary = pd.Timestamp.now(tz="UTC").floor("10min")
        frame = pd.DataFrame({
            "time": pd.date_range(end=boundary, periods=50, freq="10min", tz="UTC"),
            "close": [100.0] * 50,
        })
        with tempfile.TemporaryDirectory() as directory:
            watcher = Watcher(
                _settings(directory), Database(Path(directory) / "watcher.sqlite3"), FakeSource(frame), FakePush()  # type: ignore[arg-type]
            )
            with self.assertRaises(RetryPoll):
                watcher._poll_timeframe(10)
            self.assertNotIn(10, watcher._observed_current_bar)

    def test_last_session_candle_closes_by_clock_without_a_new_tick(self) -> None:
        current_open = pd.Timestamp("2026-01-02T20:50:00Z")
        frame = pd.DataFrame({
            "time": pd.date_range(end=current_open, periods=120, freq="10min", tz="UTC"),
            "close": [100.0] * 119 + [120.0],
        })
        source = FakeSource(frame)
        with tempfile.TemporaryDirectory() as directory:
            watcher = Watcher(
                _settings(directory, bar_close_grace_seconds=2),
                Database(Path(directory) / "watcher.sqlite3"),
                source,
                FakePush(),  # type: ignore[arg-type]
            )
            forming_time = pd.Timestamp("2026-01-02T20:55:00Z").to_pydatetime()
            closed_time = pd.Timestamp("2026-01-02T21:00:03Z").to_pydatetime()
            with patch("backend.watcher.utc_now", return_value=forming_time):
                self.assertEqual(watcher._poll_timeframe(10), [])
            with patch("backend.watcher.utc_now", return_value=closed_time):
                pending = watcher._poll_timeframe(10)
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["bar_open"], "2026-01-02T20:50:00Z")
            self.assertTrue(watcher.snapshot()["timeframes"]["10"]["provisional"])

    def test_by_clock_evaluation_is_provisional_and_rechecked_on_final_data(self) -> None:
        # Bar T0 is still flat when the wall clock says it closed (no next tick yet). Later the
        # feed delivers the real close of T0 (a cross) together with the next bar: the cross
        # must still be alerted, exactly once, and the cursor must only then advance past T0.
        t0 = pd.Timestamp("2026-01-05T10:00:00Z")
        frame = pd.DataFrame({
            "time": pd.date_range(end=t0, periods=120, freq="10min", tz="UTC"),
            "close": [100.0] * 120,
        })
        source = FakeSource(frame)
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "watcher.sqlite3")
            watcher = Watcher(
                _settings(directory, bar_close_grace_seconds=5), database, source, FakePush()  # type: ignore[arg-type]
            )
            state_key = "last_closed:XAUUSDm:10"

            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:03:00Z").to_pydatetime()):
                self.assertEqual(watcher._poll_timeframe(10), [])  # seeds at T0-10m
            self.assertEqual(database.get_state(state_key), "2026-01-05T09:50:00Z")

            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:10:06Z").to_pydatetime()):
                self.assertEqual(watcher._poll_timeframe(10), [])  # by clock: flat, no cross
            self.assertTrue(watcher.snapshot()["timeframes"]["10"]["provisional"])
            self.assertEqual(database.get_state(state_key), "2026-01-05T09:50:00Z", "provisional bar must not advance the cursor")

            # Delayed ticks arrive: T0 actually closed at 120 and the next bar has opened.
            source.frame.loc[source.frame.index[-1], "close"] = 120.0
            source.frame = pd.concat(
                [source.frame, pd.DataFrame({"time": [t0 + pd.Timedelta(minutes=10)], "close": [121.0]})],
                ignore_index=True,
            )
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:10:09Z").to_pydatetime()):
                pending = watcher._poll_timeframe(10)
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["bar_open"], "2026-01-05T10:00:00Z")
            self.assertEqual(pending[0]["direction"], "bullish")
            self.assertEqual(database.get_state(state_key), "2026-01-05T10:00:00Z")
            self.assertFalse(watcher.snapshot()["timeframes"]["10"]["provisional"])

            # Nothing new on the next poll, and the alert count stays at one.
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:10:10Z").to_pydatetime()):
                self.assertEqual(watcher._poll_timeframe(10), [])
            self.assertEqual(len(database.list_alerts()), 1)

    def test_clock_skew_bound_widens_the_by_clock_grace(self) -> None:
        t0 = pd.Timestamp("2026-01-05T10:00:00Z")
        frame = pd.DataFrame({
            "time": pd.date_range(end=t0, periods=120, freq="10min", tz="UTC"),
            "close": [100.0] * 120,
        })
        source = FakeSource(frame)
        with tempfile.TemporaryDirectory() as directory:
            watcher = Watcher(
                _settings(directory, bar_close_grace_seconds=5),
                Database(Path(directory) / "watcher.sqlite3"),
                source,
                FakePush(),  # type: ignore[arg-type]
            )
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:03:00Z").to_pydatetime()):
                watcher._poll_timeframe(10)
            # A new bar is first seen 8 s after its open: the PC clock can be at most ~8 s ahead.
            source.frame = pd.concat(
                [source.frame, pd.DataFrame({"time": [t0 + pd.Timedelta(minutes=10)], "close": [100.0]})],
                ignore_index=True,
            )
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:10:08Z").to_pydatetime()):
                watcher._poll_timeframe(10)
            self.assertAlmostEqual(watcher._skew_upper_seconds or 0.0, 8.0)
            self.assertAlmostEqual(watcher._effective_grace_seconds(), 13.0)

            # 10:20:06 is past the 5 s grace but inside the skew allowance: still forming.
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:20:06Z").to_pydatetime()):
                watcher._poll_timeframe(10)
            self.assertFalse(watcher.snapshot()["timeframes"]["10"]["provisional"])
            with patch("backend.watcher.utc_now", return_value=pd.Timestamp("2026-01-05T10:20:14Z").to_pydatetime()):
                watcher._poll_timeframe(10)
            self.assertTrue(watcher.snapshot()["timeframes"]["10"]["provisional"])


if __name__ == "__main__":
    unittest.main()
