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


class TwelveDataSource:
    """Cloud market data feed from Twelve Data REST API.

    Allows the watcher to run 24/7 in cloud environments (Render, Railway, VPS)
    without needing a local Windows MetaTrader 5 terminal open.
    """

    BASE_URL = "https://api.twelvedata.com/time_series"

    def __init__(
        self,
        api_key: str,
        default_symbol: str = "XAU/USD",
        min_bars: int = 100,
        cache_ttl_seconds: float = 3.0,
    ):
        self.api_key = api_key
        self.default_symbol = default_symbol
        self.min_bars = min_bars
        self.cache_ttl_seconds = cache_ttl_seconds
        self._cache: dict[tuple[str, str], tuple[float, pd.DataFrame]] = {}
        self._lock = threading.RLock()
        self._announced = False

    def connect(self) -> None:
        if not self._announced:
            logger.info("Connected to Twelve Data cloud feed for %s", self.default_symbol)
            self._announced = True

    def close(self) -> None:
        return None

    def _map_symbol(self, symbol: str) -> str:
        s = symbol.upper().strip()
        if "XAU" in s:
            return self.default_symbol
        return s

    def _fetch_series(self, symbol: str, interval: str, count: int) -> pd.DataFrame:
        now = time.monotonic()
        cache_key = (symbol, interval)
        with self._lock:
            if cache_key in self._cache:
                cached_time, cached_df = self._cache[cache_key]
                if now - cached_time < self.cache_ttl_seconds and len(cached_df) >= count:
                    return cached_df.tail(count).copy()

        import json
        import urllib.error
        import urllib.parse
        import urllib.request

        params = {
            "symbol": symbol,
            "interval": interval,
            "outputsize": max(count, self.min_bars),
            "apikey": self.api_key,
            "timezone": "UTC",
        }
        url = f"{self.BASE_URL}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": "AurumSignal/1.0"})

        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise MarketDataError(f"Twelve Data HTTP {exc.code}: {error_body}") from exc
        except Exception as exc:
            raise MarketDataError(f"Twelve Data network error: {exc}") from exc

        if data.get("status") == "error":
            raise MarketDataError(
                f"Twelve Data API error {data.get('code')}: {data.get('message', 'Unknown error')}"
            )

        values = data.get("values")
        if not values or not isinstance(values, list):
            raise MarketDataError(f"No candle values returned by Twelve Data for {symbol} {interval}")

        df = pd.DataFrame(values)
        df["time"] = pd.to_datetime(df["datetime"], utc=True)
        for col in ("open", "high", "low", "close"):
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        if "volume" in df.columns:
            df["tick_volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype(int)
        else:
            df["tick_volume"] = 0

        df = df.sort_values("time").drop_duplicates("time", keep="last").reset_index(drop=True)

        with self._lock:
            self._cache[cache_key] = (now, df)

        return df.tail(count).copy()

    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame:
        mapped_symbol = self._map_symbol(symbol)
        if timeframe_minutes == 15:
            df = self._fetch_series(mapped_symbol, "15min", count)
        elif timeframe_minutes == 10:
            # Twelve Data has no native 10m interval: fetch 5m candles and resample 2-by-2
            needed_5m = max(count * 2 + 2, self.min_bars * 2)
            df_5m = self._fetch_series(mapped_symbol, "5min", needed_5m)
            df_indexed = df_5m.set_index("time")
            resampled = (
                df_indexed.resample("10min", origin="epoch")
                .agg({
                    "open": "first",
                    "high": "max",
                    "low": "min",
                    "close": "last",
                    "tick_volume": "sum",
                })
                .dropna(subset=["close"])
                .reset_index()
            )
            df = resampled.tail(count).reset_index(drop=True)
        else:
            raise MarketDataError(f"Unsupported Twelve Data timeframe: {timeframe_minutes}m (supported: 10m, 15m)")

        minimum = min(count, self.min_bars)
        if len(df) < minimum:
            raise MarketDataError(
                f"Not enough {symbol} M{timeframe_minutes} bars ({len(df)} < {minimum}) from Twelve Data"
            )

        return df.sort_values("time").reset_index(drop=True)


def make_source(settings: Settings) -> MarketDataSource:
    if settings.data_source == "demo":
        return DemoSource()
    if settings.data_source == "twelvedata":
        if not settings.twelvedata_api_key:
            raise MarketDataError("TWELVEDATA_API_KEY is required when DATA_SOURCE=twelvedata")
        return TwelveDataSource(
            api_key=settings.twelvedata_api_key,
            default_symbol=settings.twelvedata_symbol,
            min_bars=settings.min_history_bars,
        )
    if settings.data_source != "mt5":
        raise ValueError(f"Unknown DATA_SOURCE: {settings.data_source}")
    return MT5Source(settings.mt5_terminal_path, min_bars=settings.min_history_bars)
