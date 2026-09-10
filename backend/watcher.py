from __future__ import annotations

import ctypes
import logging
import queue
import sys
import threading
import time
from datetime import datetime
from typing import Any

import pandas as pd

from .config import Settings
from .database import Database
from .line_service import LineNotifier
from .macd import calculate_macd, cross_at, event_id, iso_utc, point_from_row, utc_now
from .market_data import MarketDataError, MarketDataSource
from .push_service import PushService


logger = logging.getLogger(__name__)

# Windows power-request flags for SetThreadExecutionState.
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

# Only trust a "first sight of a new bar" for clock-skew estimation when it happened
# within this many seconds of the bar's open; later sightings (resume from sleep, quiet
# market) say nothing about the clock.
SKEW_SAMPLE_MAX_AGE_SECONDS = 60.0

# Closed candles (with MACD values) kept per timeframe for the chart and published to the cloud.
CANDLE_HISTORY = 200


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # NaN -> None


class RetryPoll(Exception):
    """A benign per-timeframe condition: try again next cycle, keep the MT5 session open."""


def _set_keep_awake(enabled: bool) -> bool:
    """Ask Windows not to sleep while the calling thread lives. Lid-close still wins."""
    if sys.platform != "win32":
        return False
    try:
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if enabled else ES_CONTINUOUS
        return bool(ctypes.windll.kernel32.SetThreadExecutionState(flags))  # type: ignore[attr-defined]
    except Exception:
        logger.exception("SetThreadExecutionState failed")
        return False


def _as_utc(value: object) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


class Watcher:
    def __init__(
        self,
        settings: Settings,
        database: Database,
        source: MarketDataSource,
        push: PushService,
    ):
        self.settings = settings
        self.database = database
        self.source = source
        self.push = push
        self._stop = threading.Event()
        self._delivery_wakeup = threading.Event()
        self._thread: threading.Thread | None = None
        self._delivery_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._observed_current_bar: dict[int, str] = {}
        self._last_probe_open: dict[int, pd.Timestamp] = {}
        self._skew_upper_seconds: float | None = None
        self._last_cycle_at: datetime | None = None
        self._last_heartbeat_at: float = 0.0
        self._candles: dict[int, list[dict[str, Any]]] = {}
        self._candles_published_until: dict[int, str] = {}
        self._candles_published_key: dict[int, str] = {}
        self._forming_candles: dict[int, dict[str, Any]] = {}
        # Cloud uploads (candles, heartbeats) never run on the watcher thread: they are queued
        # here and sent by the outbox thread, so a slow network cannot delay alert detection.
        self._cloud_jobs: "queue.Queue[tuple[str, tuple[Any, ...]]]" = queue.Queue()
        self._heartbeat_queued = False
        self.line_notifier = LineNotifier(settings)
        self._snapshot: dict[str, Any] = {
            "running": False,
            "connected": False,
            "source": settings.data_source,
            "symbol": settings.mt5_symbol,
            "directions": list(settings.alert_directions),
            "line_configured": self.line_notifier.is_configured,
            "line_bot_id": settings.line_bot_id,
            "line_bot_add_url": settings.line_bot_add_url,
            "last_poll_at": None,
            "last_error": None,
            "started_at": None,
            "last_push_at": None,
            "last_push_error": None,
            "keep_awake": False,
            "clock_skew_upper_s": None,
            "last_offline_gap_s": None,
            "last_offline_gap_at": None,
            "stale_crosses_skipped": 0,
            "timeframes": {},
        }

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="macd-watcher", daemon=True)
        self._delivery_thread = threading.Thread(
            target=self._delivery_run, name="push-outbox", daemon=True
        )
        self._thread.start()
        self._delivery_thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._delivery_wakeup.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._delivery_thread:
            self._delivery_thread.join(timeout=12)
        self.source.close()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            timeframes = {}
            for key, value in self._snapshot["timeframes"].items():
                card = dict(value)
                try:
                    tf_num = int(key)
                    if tf_num in self._forming_candles:
                        card["forming"] = dict(self._forming_candles[tf_num])
                except (ValueError, TypeError):
                    pass
                timeframes[key] = card
            return {
                **self._snapshot,
                "delivery_alive": bool(self._delivery_thread and self._delivery_thread.is_alive()),
                "timeframes": timeframes,
            }

    def _update(self, **values: Any) -> None:
        with self._lock:
            self._snapshot.update(values)

    def candles(self, timeframe: int) -> list[dict[str, Any]]:
        """Recent closed candles with MACD for one timeframe (oldest first)."""
        with self._lock:
            return [dict(row) for row in self._candles.get(timeframe, [])]

    def forming_candle(self, timeframe: int) -> dict[str, Any] | None:
        """Current unclosed candle being formed in real time."""
        with self._lock:
            val = self._forming_candles.get(timeframe)
            return dict(val) if val else None

    # ------------------------------------------------------------------ chart data

    def _capture_candles(self, timeframe: int, calculated: pd.DataFrame, provisional_last: bool) -> None:
        tail = calculated.iloc[-CANDLE_HISTORY:]
        rows: list[dict[str, Any]] = []
        last_index = len(tail) - 1
        for position, (_, row) in enumerate(tail.iterrows()):
            close = _finite(row.get("close"))
            if close is None:
                continue
            rows.append({
                "time": iso_utc(pd.Timestamp(row["time"]).to_pydatetime()),
                "open": _finite(row.get("open", close)) if "open" in row else close,
                "high": _finite(row.get("high", close)) if "high" in row else close,
                "low": _finite(row.get("low", close)) if "low" in row else close,
                "close": close,
                "macd": _finite(row.get("macd")),
                "signal": _finite(row.get("signal")),
                "histogram": _finite(row.get("histogram")),
                "provisional": provisional_last and position == last_index,
            })
        with self._lock:
            self._candles[timeframe] = rows

    def _mark_observed(self, timeframe: int, observation_key: str) -> None:
        """Record that this bar state was fully processed; queue the candle upload once per state.

        Called only after the local work (state, alert insert) succeeded, so a local failure
        never produces a network call, and the same bar state is never re-sent every cycle.
        """
        self._observed_current_bar[timeframe] = observation_key
        if getattr(self.push, "publish_candles", None) is None:
            return
        if self._candles_published_key.get(timeframe) == observation_key:
            return
        rows = self.candles(timeframe)
        if not rows:
            return
        self._candles_published_key[timeframe] = observation_key
        since = self._candles_published_until.get(timeframe)
        if since is None:
            to_send = rows
        else:
            # New bars plus the two before them: a provisional (by-clock) candle may have been revised.
            newer = [row for row in rows if row["time"] > since]
            to_send = rows[-2:] if not newer else rows[max(0, len(rows) - len(newer) - 2):]
        self._candles_published_until[timeframe] = rows[-1]["time"]
        self._cloud_jobs.put(("candles", (self.settings.mt5_symbol, timeframe, to_send)))
        self._delivery_wakeup.set()

    # ------------------------------------------------------------------ watcher thread

    def _run(self) -> None:
        # The power request is per thread, so it must be made (and released) here.
        keep_awake = _set_keep_awake(True)
        if not keep_awake and sys.platform == "win32":
            logger.warning("Could not set the keep-awake power request; the laptop may sleep")
        self._update(running=True, started_at=iso_utc(utc_now()), keep_awake=keep_awake)
        reconnect_delay = 1.0
        try:
            while not self._stop.is_set():
                cycle_started = time.monotonic()
                self._note_cycle_gap(utc_now())
                try:
                    self.source.connect()
                    self._update(connected=True, last_error=None)
                    for timeframe in self.settings.timeframes:
                        try:
                            self._poll_timeframe(timeframe)
                        except RetryPoll as exc:
                            logger.debug("M%s poll deferred: %s", timeframe, exc)
                    self._update(last_poll_at=iso_utc(utc_now()))
                    reconnect_delay = 1.0
                    self._maybe_heartbeat(connected=True)
                except MarketDataError as exc:
                    message = f"{type(exc).__name__}: {exc}"
                    if message != self.snapshot().get("last_error"):
                        logger.warning("Watcher feed error: %s", message)
                    self._update(connected=False, last_error=message, last_poll_at=iso_utc(utc_now()))
                    self.source.close()
                    self._maybe_heartbeat(connected=False)
                    self._stop.wait(reconnect_delay)
                    reconnect_delay = min(30.0, reconnect_delay * 2)
                except Exception as exc:
                    # A local failure (SQLite, a bug) must not tear down the MT5 IPC session.
                    message = f"{type(exc).__name__}: {exc}"
                    logger.exception("Watcher cycle error; feed kept open: %s", message)
                    self._update(last_error=message, last_poll_at=iso_utc(utc_now()))
                    self._stop.wait(2.0)

                elapsed = time.monotonic() - cycle_started
                self._stop.wait(max(0.0, self.settings.poll_interval_seconds - elapsed))
        finally:
            _set_keep_awake(False)
            self._update(running=False, connected=False, keep_awake=False)

    def _maybe_heartbeat(self, connected: bool) -> None:
        """In cloud mode the sink also carries a heartbeat so the watchdog can tell silence from calm."""
        if getattr(self.push, "heartbeat", None) is None:
            return
        now = time.monotonic()
        if now - self._last_heartbeat_at < self.settings.heartbeat_interval_seconds or self._heartbeat_queued:
            return
        self._last_heartbeat_at = now
        self._heartbeat_queued = True
        self._cloud_jobs.put(("heartbeat", (connected, self.snapshot())))
        self._delivery_wakeup.set()

    def _drain_cloud_jobs(self) -> None:
        """Run queued cloud uploads on the outbox thread. Failures are logged, never raised."""
        while True:
            try:
                kind, args = self._cloud_jobs.get_nowait()
            except queue.Empty:
                return
            try:
                if kind == "heartbeat":
                    self._heartbeat_queued = False
                    self.push.heartbeat(*args)  # type: ignore[attr-defined]
                elif kind == "candles":
                    self.push.publish_candles(*args)  # type: ignore[attr-defined]
            except Exception as exc:
                if kind == "heartbeat":
                    self._heartbeat_queued = False
                logger.warning("Cloud upload (%s) failed: %s: %s", kind, type(exc).__name__, exc)
                self._update(last_push_error=f"{kind}: {type(exc).__name__}: {exc}")

    def _note_cycle_gap(self, now: datetime) -> None:
        """Detect that this process was frozen (sleep, hang) or restarted late."""
        previous = self._last_cycle_at
        self._last_cycle_at = now
        if previous is None:
            return
        gap = (now - previous).total_seconds()
        if gap >= self.settings.offline_gap_alert_seconds:
            logger.warning(
                "Watcher was not running for %.0f s (sleep, hang or restart). Crosses that closed more than "
                "%s s ago are skipped, not pushed.",
                gap,
                self.settings.catch_up_max_age_seconds,
            )
            self._update(last_offline_gap_s=round(gap), last_offline_gap_at=iso_utc(now))

    def _observe_bar_clock(self, timeframe: int, probe_current: pd.Timestamp, observed_at: datetime) -> None:
        """Track how far the local clock can be ahead of the broker clock.

        MT5 creates a bar on the first tick with server time >= bar open. The first time we see
        a new bar, ``local_now - bar_open`` equals local-minus-server skew plus a little tick and
        poll latency, so its running minimum is an upper bound on how far ahead the PC clock runs.
        The wall-clock close fallback adds this bound to its grace so it never evaluates a bar the
        server still considers open.
        """
        previous = self._last_probe_open.get(timeframe)
        if previous is not None and probe_current <= previous:
            return
        self._last_probe_open[timeframe] = probe_current
        if previous is None:
            return  # first sighting after startup says nothing about when the bar opened
        delta = (observed_at - probe_current.to_pydatetime()).total_seconds()
        if -SKEW_SAMPLE_MAX_AGE_SECONDS < delta < SKEW_SAMPLE_MAX_AGE_SECONDS:
            self._skew_upper_seconds = (
                delta if self._skew_upper_seconds is None else min(self._skew_upper_seconds, delta)
            )
            self._update(clock_skew_upper_s=round(self._skew_upper_seconds, 2))

    def _effective_grace_seconds(self) -> float:
        return self.settings.bar_close_grace_seconds + max(0.0, self._skew_upper_seconds or 0.0)

    # ------------------------------------------------------------------ delivery thread

    def _delivery_run(self) -> None:
        while not self._stop.is_set():
            try:
                self._drain_cloud_jobs()
                due = self.database.due_outbox_alerts()
                if not due:
                    self._delivery_wakeup.wait(1.0)
                    self._delivery_wakeup.clear()
                    continue
                for alert in due:
                    if self._stop.is_set():
                        return
                    self._deliver_one(alert)
            except Exception as exc:
                # Nothing in here may kill the thread: a locked database or a transient I/O error
                # would otherwise leave every future alert stranded as "Logged".
                message = f"{type(exc).__name__}: {exc}"
                logger.exception("Push outbox loop error: %s", message)
                self._update(last_push_error=message)
                self._stop.wait(2.0)

    def _deliver_one(self, alert: dict[str, Any]) -> None:
        try:
            result = self.push.broadcast_alert(alert)
            if self.line_notifier.is_configured:
                try:
                    self.line_notifier.send_alert(alert)
                except Exception as line_exc:
                    logger.warning("LINE alert failed for %s: %s", alert["id"], line_exc)
            if result["failed"] == 0:
                self.database.complete_outbox(alert["id"])
                self._update(last_push_at=iso_utc(utc_now()), last_push_error=None)
                logger.info("Push outbox completed for %s: %s", alert["id"], result)
            else:
                attempts = int(alert.get("outbox_attempts", 0)) + 1
                delay = min(300, 2 ** min(attempts, 8))
                message = f"{result['failed']} push endpoint(s) failed"
                self.database.retry_outbox(alert["id"], message, delay)
                self._update(last_push_error=message)
        except Exception as exc:
            attempts = int(alert.get("outbox_attempts", 0)) + 1
            delay = min(300, 2 ** min(attempts, 8))
            message = f"{type(exc).__name__}: {exc}"
            self.database.retry_outbox(alert["id"], message, delay)
            self._update(last_push_error=message)
            logger.exception("Push outbox error for %s", alert["id"])

    # ------------------------------------------------------------------ candle evaluation

    def _poll_timeframe(self, timeframe: int) -> list[dict[str, Any]]:
        probe = self.source.bars(self.settings.mt5_symbol, timeframe, 2)
        sorted_probe = probe.sort_values("time")
        last_probe_row = sorted_probe.iloc[-1]
        probe_current = _as_utc(last_probe_row["time"])
        observed_at = utc_now()
        self._observe_bar_clock(timeframe, probe_current, observed_at)

        close_val = _finite(last_probe_row.get("close"))
        if close_val is not None:
            open_val = _finite(last_probe_row.get("open", close_val))
            high_val = _finite(last_probe_row.get("high", close_val))
            low_val = _finite(last_probe_row.get("low", close_val))
            forming = {
                "time": iso_utc(pd.Timestamp(last_probe_row["time"]).to_pydatetime()),
                "open": open_val if open_val is not None else close_val,
                "high": high_val if high_val is not None else close_val,
                "low": low_val if low_val is not None else close_val,
                "close": close_val,
            }
            with self._lock:
                self._forming_candles[timeframe] = forming

        scheduled_close = probe_current.to_pydatetime() + pd.Timedelta(minutes=timeframe)
        close_by_clock = (
            observed_at - scheduled_close
        ).total_seconds() >= self._effective_grace_seconds()
        probe_iso = probe_current.isoformat()
        observation_key = f"{probe_iso}:{'closed' if close_by_clock else 'forming'}"
        if self._observed_current_bar.get(timeframe) == observation_key:
            return []

        # MT5 creates the new current candle on its first tick. Capture when this
        # process first observes it, then do the larger history calculation once.
        first_tick_at = observed_at
        frame = self.source.bars(self.settings.mt5_symbol, timeframe, self.settings.history_bars)
        if len(frame) < self.settings.min_history_bars:
            raise RetryPoll(
                f"M{timeframe} returned {len(frame)} candles; {self.settings.min_history_bars} are needed "
                "for a converged MACD (terminal history may still be syncing)"
            )

        frame = frame.sort_values("time").drop_duplicates("time", keep="last").reset_index(drop=True)
        current_bar_open = _as_utc(frame.iloc[-1]["time"])
        if current_bar_open != probe_current:
            raise RetryPoll(f"M{timeframe} advanced while candle history was loading")

        # Normally a new tick has created the next bar and the last row is forming.
        # If a session ends with no next tick (daily break, Friday close), the wall-clock
        # fallback closes the final row after the grace period. That evaluation is
        # PROVISIONAL: the cursor is not advanced past it, so when the real next bar
        # appears the row is evaluated again on final data and INSERT OR IGNORE keeps
        # any already-sent alert from repeating.
        closed = frame.copy() if close_by_clock else frame.iloc[:-1].copy()
        calculated = calculate_macd(closed, timeframe)
        latest_index = len(calculated) - 1
        latest = point_from_row(calculated.iloc[latest_index])
        self._capture_candles(timeframe, calculated, provisional_last=close_by_clock)
        detected_at = utc_now()
        detection_delay_ms = max(0, round((detected_at - latest.bar_close).total_seconds() * 1000))
        current_bar_age_seconds = max(
            0.0, (detected_at - current_bar_open.to_pydatetime()).total_seconds()
        )

        state_key = f"last_closed:{self.settings.mt5_symbol}:{timeframe}"
        last_value = self.database.get_state(state_key)
        latest_open_iso = iso_utc(latest.bar_open)

        card = {
            "timeframe_minutes": timeframe,
            "bar_open": latest_open_iso,
            "bar_close": iso_utc(latest.bar_close),
            "price": latest.price,
            "macd": latest.macd,
            "signal": latest.signal,
            "histogram": latest.histogram,
            "trend": "bullish" if latest.histogram > 0 else "bearish",
            "detected_at": iso_utc(detected_at),
            "detection_delay_ms": detection_delay_ms,
            "feed_fresh": current_bar_age_seconds <= timeframe * 60 * 2,
            "provisional": close_by_clock,
        }
        with self._lock:
            self._snapshot["timeframes"][str(timeframe)] = card

        if last_value is None:
            self.database.set_state(state_key, latest_open_iso)
            self._mark_observed(timeframe, observation_key)
            logger.info("Seeded %s M%s at %s; no stale alert sent", self.settings.mt5_symbol, timeframe, latest_open_iso)
            return []

        last_open = pd.Timestamp(last_value)
        unseen = calculated.index[calculated["time"] > last_open].tolist()
        if not unseen:
            self._mark_observed(timeframe, observation_key)
            return []

        pending_pushes: list[dict[str, Any]] = []
        skipped_stale = 0
        for index in unseen:
            point = point_from_row(calculated.iloc[index])
            age_seconds = max(0.0, (detected_at - point.bar_close).total_seconds())
            cross = cross_at(calculated, index)
            if cross and cross.direction in self.settings.alert_directions:
                if age_seconds <= self.settings.catch_up_max_age_seconds:
                    alert = {
                        "id": event_id(self.settings.mt5_symbol, timeframe, cross.current.bar_open, cross.direction),
                        "symbol": self.settings.mt5_symbol,
                        "timeframe_minutes": timeframe,
                        "direction": cross.direction,
                        "bar_open": iso_utc(cross.current.bar_open),
                        "bar_close": iso_utc(cross.current.bar_close),
                        "price": cross.current.price,
                        "previous_macd": cross.previous.macd,
                        "previous_signal": cross.previous.signal,
                        "macd": cross.current.macd,
                        "signal": cross.current.signal,
                        "histogram": cross.current.histogram,
                        "detected_at": iso_utc(detected_at),
                        "first_tick_at": iso_utc(first_tick_at),
                        "detection_delay_ms": max(
                            0, round((detected_at - cross.current.bar_close).total_seconds() * 1000)
                        ),
                        "created_at": iso_utc(utc_now()),
                    }
                    if self.database.insert_alert(alert):
                        logger.info("Confirmed %s MACD cross: %s", cross.direction, alert["id"])
                        pending_pushes.append(alert)
                        self._delivery_wakeup.set()
                else:
                    skipped_stale += 1
                    logger.warning(
                        "Skipping %s cross on %s M%s bar %s: closed %.0f s ago (limit %s s)",
                        cross.direction, self.settings.mt5_symbol, timeframe,
                        iso_utc(point.bar_open), age_seconds, self.settings.catch_up_max_age_seconds,
                    )
            provisional = close_by_clock and index == latest_index
            if not provisional:
                self.database.set_state(state_key, iso_utc(point.bar_open))
        if skipped_stale:
            with self._lock:
                self._snapshot["stale_crosses_skipped"] += skipped_stale
        self._mark_observed(timeframe, observation_key)
        return pending_pushes
