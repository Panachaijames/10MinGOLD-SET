from __future__ import annotations

import unittest
from datetime import datetime, timezone

import pandas as pd

from backend.macd import bullish_cross_at, calculate_macd, cross_at, event_id


def _rows(histograms: list[float], timeframe: int = 10) -> pd.DataFrame:
    count = len(histograms)
    return pd.DataFrame({
        "time": pd.date_range("2026-01-01", periods=count, freq=f"{timeframe}min", tz="UTC"),
        "bar_close": pd.date_range(f"2026-01-01 00:{timeframe:02d}", periods=count, freq=f"{timeframe}min", tz="UTC"),
        "close": [2300.0 + index for index in range(count)],
        "macd": [0.2 + value for value in histograms],
        "signal": [0.2] * count,
        "histogram": histograms,
    })


class MacdTests(unittest.TestCase):
    def test_calculation_uses_ewm_and_adds_bar_close(self) -> None:
        frame = pd.DataFrame({
            "time": pd.date_range("2026-01-01", periods=80, freq="10min", tz="UTC"),
            "close": [100 + index * 0.1 for index in range(80)],
        })
        result = calculate_macd(frame, 10)
        self.assertEqual(len(result), 80)
        self.assertEqual(result.iloc[-1]["bar_close"], result.iloc[-1]["time"] + pd.Timedelta(minutes=10))
        self.assertFalse(pd.isna(result.iloc[-1]["histogram"]))

    def test_macd_converges_with_more_warmup(self) -> None:
        # Seeding on the first value must not matter once >= 260 candles are used.
        closes = [2300 + 3 * ((index * 7919) % 13) / 13 + index * 0.02 for index in range(700)]
        frame = pd.DataFrame({
            "time": pd.date_range("2026-01-01", periods=700, freq="10min", tz="UTC"),
            "close": closes,
        })
        full = calculate_macd(frame, 10).iloc[-1]
        shorter = calculate_macd(frame.iloc[-300:].reset_index(drop=True), 10).iloc[-1]
        self.assertAlmostEqual(float(full["histogram"]), float(shorter["histogram"]), places=6)

    def test_bullish_cross_is_previous_non_positive_to_current_positive(self) -> None:
        cross = bullish_cross_at(_rows([0.0, 0.05]), 1)
        self.assertIsNotNone(cross)
        assert cross is not None
        self.assertEqual(cross.direction, "bullish")
        self.assertEqual(cross.current.price, 2301.0)

    def test_bearish_cross_is_previous_non_negative_to_current_negative(self) -> None:
        cross = cross_at(_rows([0.01, -0.04]), 1)
        self.assertIsNotNone(cross)
        assert cross is not None
        self.assertEqual(cross.direction, "bearish")
        self.assertIsNone(bullish_cross_at(_rows([0.01, -0.04]), 1))

    def test_touching_zero_counts_as_the_side_being_left(self) -> None:
        # Pine ta.crossover / ta.crossunder semantics: equality on the previous bar counts.
        self.assertEqual(cross_at(_rows([0.0, 0.05]), 1).direction, "bullish")  # type: ignore[union-attr]
        self.assertEqual(cross_at(_rows([0.0, -0.05]), 1).direction, "bearish")  # type: ignore[union-attr]
        self.assertIsNone(cross_at(_rows([0.0, 0.0]), 1))
        # A dip to exactly zero and back does not repeat the same signal.
        rows = _rows([0.05, 0.0, 0.05])
        self.assertIsNone(cross_at(rows, 1))
        self.assertEqual(cross_at(rows, 2).direction, "bullish")  # type: ignore[union-attr]

    def test_no_cross_when_previous_already_positive(self) -> None:
        self.assertIsNone(cross_at(_rows([0.01, 0.05]), 1))
        self.assertIsNone(cross_at(_rows([-0.01, -0.05]), 1))

    def test_nan_histogram_never_crosses(self) -> None:
        self.assertIsNone(cross_at(_rows([float("nan"), 0.05]), 1))
        self.assertIsNone(cross_at(_rows([0.0, 0.05]), 0))

    def test_event_id_encodes_direction(self) -> None:
        opened = datetime(2026, 9, 8, 3, 10, tzinfo=timezone.utc)
        self.assertEqual(event_id("XAUUSDm", 10, opened), "XAUUSDm:10m:20260908T031000Z:bullish")
        self.assertEqual(event_id("XAUUSDm", 10, opened, "bearish"), "XAUUSDm:10m:20260908T031000Z:bearish")


if __name__ == "__main__":
    unittest.main()
