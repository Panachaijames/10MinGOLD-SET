from __future__ import annotations

import logging
import math
import threading
import time
from datetime import datetime, timezone
from typing import Protocol

import pandas as pd

from .config import Settings


logger = logging.getLogger(__name__)


class MarketDataError(RuntimeError):
    pass


class MarketDataSource(Protocol):
    def connect(self) -> None: ...
    def close(self) -> None: ...
    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame: ...


class MT5Source:
    def __init__(self, terminal_path: str | None = None, min_bars: int = 100):
        self.terminal_path = terminal_path
        self.min_bars = min_bars
        self._mt5 = None
        self._connected = False
        self._lock = threading.RLock()

    def connect(self) -> None:
        with self._lock:
            if self._connected:
                return
            try:
                import MetaTrader5 as mt5
            except ImportError as exc:
                raise MarketDataError("MetaTrader5 package is not installed") from exc
            kwargs = {"path": self.terminal_path} if self.terminal_path else {}
            if not mt5.initialize(**kwargs):
                raise MarketDataError(f"MT5 initialize failed: {mt5.last_error()}")
            self._mt5 = mt5
            self._connected = True
            logger.info("Connected to the signed-in MT5 terminal")

    def close(self) -> None:
        with self._lock:
            if self._connected and self._mt5:
                self._mt5.shutdown()
            self._connected = False

    def _timeframe(self, minutes: int) -> int:
        if not self._mt5:
            raise MarketDataError("MT5 is not connected")
        mapping = {10: self._mt5.TIMEFRAME_M10, 15: self._mt5.TIMEFRAME_M15}
        try:
            return mapping[minutes]
        except KeyError as exc:
            raise MarketDataError(f"Unsupported MT5 timeframe: {minutes}") from exc

    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame:
        with self._lock:
            if not self._connected:
                self.connect()
            mt5 = self._mt5
            assert mt5 is not None
            terminal = mt5.terminal_info()
            if terminal is None or not terminal.connected:
                raise MarketDataError(f"MT5 terminal is disconnected: {mt5.last_error()}")
            if not mt5.symbol_select(symbol, True):
                raise MarketDataError(f"MT5 symbol is unavailable: {symbol}; {mt5.last_error()}")
            rates = mt5.copy_rates_from_pos(symbol, self._timeframe(timeframe_minutes), 0, count)
            minimum = min(count, self.min_bars)
            if rates is None or len(rates) < minimum:
                got = 0 if rates is None else len(rates)
                raise MarketDataError(
                    f"Not enough {symbol} M{timeframe_minutes} bars ({got} < {minimum}); "
                    f"terminal history may still be syncing: {mt5.last_error()}"
                )
            frame = pd.DataFrame(rates)
            frame["time"] = pd.to_datetime(frame["time"], unit="s", utc=True)
            return frame.sort_values("time").reset_index(drop=True)


class DemoSource:
    """A deterministic candle feed for UI testing without touching the MT5 terminal."""

    def __init__(self) -> None:
        self._announced = False

    def connect(self) -> None:
        if not self._announced:
            logger.warning("Running with DATA_SOURCE=demo; prices and signals are simulated")
            self._announced = True

    def close(self) -> None:
        return None

    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame:
        now = pd.Timestamp.now(tz="UTC")
        boundary = now.floor(f"{timeframe_minutes}min")
        times = pd.date_range(end=boundary, periods=count, freq=f"{timeframe_minutes}min", tz="UTC")
        phase = int(boundary.timestamp() // (timeframe_minutes * 60))
        close = [2300 + 0.03 * (phase - count + i) + 8 * math.sin((phase - count + i) / 7) for i in range(count)]
        return pd.DataFrame({"time": times, "close": close})


def make_source(settings: Settings) -> MarketDataSource:
    if settings.data_source == "demo":
        return DemoSource()
    if settings.data_source != "mt5":
        raise ValueError(f"Unknown DATA_SOURCE: {settings.data_source}")
    return MT5Source(settings.mt5_terminal_path, min_bars=settings.min_history_bars)
