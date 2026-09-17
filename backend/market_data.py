from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import pandas as pd

from .config import Settings


logger = logging.getLogger(__name__)

# An MT5 server stamps bars and ticks in its own timezone and never reports which one:
# Exness runs at UTC, most others at UTC+2/+3 with DST. Guessing wrong shifts every bar
# time, so the offset is measured against a live tick and every bar is moved back to true
# UTC before it leaves this module. Brokers use whole quarter hours.
SERVER_OFFSET_STEP_SECONDS = 900.0
SERVER_OFFSET_TOLERANCE_SECONDS = 180.0
# Re-measure hourly so a broker DST change is picked up without a restart, and never probe
# more than once a minute while the market is closed and no tick can answer.
SERVER_OFFSET_MAX_AGE_SECONDS = 3600.0
SERVER_OFFSET_RETRY_SECONDS = 60.0
SERVER_OFFSET_PROBE_SECONDS = 1.5


class MarketDataError(RuntimeError):
    pass


class MarketDataSource(Protocol):
    def connect(self) -> None: ...
    def close(self) -> None: ...
    def bars(self, symbol: str, timeframe_minutes: int, count: int) -> pd.DataFrame: ...


class MT5Source:
    def __init__(
        self,
        terminal_path: str | None = None,
        min_bars: int = 100,
        server_utc_offset_hours: float | None = None,
        offset_cache_path: Path | None = None,
    ):
        self.terminal_path = terminal_path
        self.min_bars = min_bars
        self._mt5 = None
        self._connected = False
        self._lock = threading.RLock()
        self._configured_offset = (
            None if server_utc_offset_hours is None else server_utc_offset_hours * 3600.0
        )
        self._offset_cache_path = offset_cache_path
        self._offset_seconds: float | None = self._configured_offset
        self._offset_measured_at: float | None = None
        self._offset_probed_at: float | None = None
        self._offset_probe_note: str | None = None

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

    # Every supported timeframe is a native MetaTrader 5 period, so candles come from the broker
    # rather than being resampled. Looked up by name so a terminal build that does not expose one
    # of them says which constant is missing instead of raising AttributeError mid-poll.
    _MT5_PERIOD_NAMES = {
        5: "TIMEFRAME_M5",
        10: "TIMEFRAME_M10",
        15: "TIMEFRAME_M15",
        30: "TIMEFRAME_M30",
        60: "TIMEFRAME_H1",
        240: "TIMEFRAME_H4",
        1440: "TIMEFRAME_D1",
    }

    def _timeframe(self, minutes: int) -> int:
        if not self._mt5:
            raise MarketDataError("MT5 is not connected")
        name = self._MT5_PERIOD_NAMES.get(minutes)
        if name is None:
            raise MarketDataError(f"Unsupported MT5 timeframe: {minutes}")
        period = getattr(self._mt5, name, None)
        if period is None:
            raise MarketDataError(f"This MetaTrader 5 build does not expose {name} (M{minutes})")
        return period

    # ------------------------------------------------------------- server clock

    @property
    def server_utc_offset_hours(self) -> float | None:
        """The broker server's timezone offset, once it is known."""
        return None if self._offset_seconds is None else self._offset_seconds / 3600.0

    @property
    def _server_name(self) -> str | None:
        info = self._mt5.account_info() if self._mt5 else None
        return getattr(info, "server", None) if info else None

    def _measure_offset_seconds(self, symbol: str) -> float | None:
        """Measure server-minus-UTC from a tick that arrives while we watch.

        A stale tick says nothing: at the weekend its timestamp is the Friday close, which
        would be read as an offset hours away from the real one. Waiting for the timestamp to
        MOVE proves the market is live, and does so without needing to know the offset first.
        """
        mt5 = self._mt5
        if mt5 is None:
            return None
        first = mt5.symbol_info_tick(symbol)
        if first is None or not first.time:
            return None
        deadline = time.monotonic() + SERVER_OFFSET_PROBE_SECONDS
        while time.monotonic() < deadline:
            time.sleep(0.1)
            latest = mt5.symbol_info_tick(symbol)
            if latest is None or not latest.time:
                return None
            if latest.time_msc == first.time_msc:
                continue
            raw = latest.time - time.time()
            candidate = round(raw / SERVER_OFFSET_STEP_SECONDS) * SERVER_OFFSET_STEP_SECONDS
            if abs(raw - candidate) > SERVER_OFFSET_TOLERANCE_SECONDS:
                # A whole-quarter-hour offset is what a timezone looks like. Anything else means
                # this PC's own clock has drifted, which would corrupt every bar-close decision.
                self._offset_probe_note = (
                    f"the broker clock reads {raw:+.0f} s from this PC, which is no timezone offset; "
                    "check the Windows clock"
                )
                logger.warning("Refusing a broker clock measurement: %s", self._offset_probe_note)
                return None
            if not -12 * 3600 <= candidate <= 14 * 3600:
                return None
            return float(candidate)
        return None

    def _read_cached_offset(self) -> float | None:
        """The last measured offset, kept so a restart while the market is shut still works."""
        path = self._offset_cache_path
        if path is None or not path.exists():
            return None
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            seconds = float(cached["offset_seconds"])
        except (OSError, ValueError, KeyError, TypeError):
            logger.warning("Ignoring unreadable broker clock cache at %s", path)
            return None
        server = cached.get("server")
        if server and self._server_name and server != self._server_name:
            logger.info("Broker changed from %s to %s; re-measuring the server clock", server, self._server_name)
            return None
        return seconds

    def _write_cached_offset(self, seconds: float) -> None:
        path = self._offset_cache_path
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({
                    "offset_seconds": seconds,
                    "server": self._server_name,
                    "measured_at": datetime.now(timezone.utc).isoformat(),
                }),
                encoding="utf-8",
            )
        except OSError:
            logger.warning("Could not store the broker clock offset at %s", path)

    def _offset_seconds_for(self, symbol: str) -> float:
        """Server-minus-UTC seconds to subtract from every bar and tick time."""
        if self._configured_offset is not None:
            return self._configured_offset
        now = time.monotonic()
        known = self._offset_seconds
        if known is not None and self._offset_measured_at is not None:
            if now - self._offset_measured_at < SERVER_OFFSET_MAX_AGE_SECONDS:
                return known
        if self._offset_probed_at is not None and now - self._offset_probed_at < SERVER_OFFSET_RETRY_SECONDS:
            if known is not None:
                return known
            raise MarketDataError(
                "Waiting for a live tick to measure the broker server clock; "
                "set MT5_SERVER_UTC_OFFSET_HOURS in .env to skip the wait"
            )
        self._offset_probed_at = now
        self._offset_probe_note = None
        measured = self._measure_offset_seconds(symbol)
        if measured is not None:
            if measured != known:
                logger.info(
                    "Broker %s runs at UTC%+g; bar times are shifted back to UTC",
                    self._server_name or "server", measured / 3600.0,
                )
            self._offset_seconds = measured
            self._offset_measured_at = now
            self._write_cached_offset(measured)
            return measured
        if known is not None:
            return known
        cached = self._read_cached_offset()
        if cached is not None:
            logger.info("Using the stored broker clock offset UTC%+g until a live tick confirms it", cached / 3600.0)
            self._offset_seconds = cached
            return cached
        reason = self._offset_probe_note or "no tick has moved yet"
        raise MarketDataError(
            f"Cannot tell what timezone the {self._server_name or 'broker'} server uses: {reason}. "
            "It resolves itself once the market trades, or set MT5_SERVER_UTC_OFFSET_HOURS in .env."
        )

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
            offset_seconds = self._offset_seconds_for(symbol)
            rates = mt5.copy_rates_from_pos(symbol, self._timeframe(timeframe_minutes), 0, count)
            minimum = min(count, self.min_bars)
            if rates is None or len(rates) < minimum:
                got = 0 if rates is None else len(rates)
                raise MarketDataError(
                    f"Not enough {symbol} M{timeframe_minutes} bars ({got} < {minimum}); "
                    f"terminal history may still be syncing: {mt5.last_error()}"
                )
            frame = pd.DataFrame(rates)
            frame["time"] = pd.to_datetime(frame["time"], unit="s", utc=True) - pd.Timedelta(
                seconds=offset_seconds
            )
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
    return MT5Source(
        settings.mt5_terminal_path,
        min_bars=settings.min_history_bars,
        server_utc_offset_hours=settings.mt5_server_utc_offset_hours,
        offset_cache_path=settings.data_dir / "mt5_server_offset.json",
    )
