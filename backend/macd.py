from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

import pandas as pd


Direction = Literal["bullish", "bearish"]
DIRECTIONS: tuple[Direction, ...] = ("bullish", "bearish")


@dataclass(frozen=True)
class MacdPoint:
    bar_open: datetime
    bar_close: datetime
    price: float
    macd: float
    signal: float
    histogram: float


@dataclass(frozen=True)
class Cross:
    direction: Direction
    previous: MacdPoint
    current: MacdPoint


# Backwards-compatible alias for callers written against the bullish-only v1 API.
BullishCross = Cross


def calculate_macd(frame: pd.DataFrame, timeframe_minutes: int) -> pd.DataFrame:
    """Return chronological closed candles with standard TradingView-style 12/26/9 MACD."""
    if "close" not in frame or "time" not in frame:
        raise ValueError("frame must contain time and close columns")

    result = frame.copy()
    result["time"] = pd.to_datetime(result["time"], utc=True)
    result = result.sort_values("time").drop_duplicates("time", keep="last").reset_index(drop=True)
    close = pd.to_numeric(result["close"], errors="raise").astype(float)
    fast = close.ewm(span=12, adjust=False, min_periods=12).mean()
    slow = close.ewm(span=26, adjust=False, min_periods=26).mean()
    result["macd"] = fast - slow
    result["signal"] = result["macd"].ewm(span=9, adjust=False, min_periods=9).mean()
    result["histogram"] = result["macd"] - result["signal"]
    result["bar_close"] = result["time"] + pd.to_timedelta(timeframe_minutes, unit="minute")
    return result


def point_from_row(row: pd.Series) -> MacdPoint:
    def as_datetime(value: object) -> datetime:
        timestamp = pd.Timestamp(value)
        if timestamp.tzinfo is None:
            timestamp = timestamp.tz_localize("UTC")
        return timestamp.to_pydatetime().astimezone(timezone.utc)

    return MacdPoint(
        bar_open=as_datetime(row["time"]),
        bar_close=as_datetime(row["bar_close"]),
        price=float(row["close"]),
        macd=float(row["macd"]),
        signal=float(row["signal"]),
        histogram=float(row["histogram"]),
    )


def cross_at(calculated: pd.DataFrame, index: int) -> Cross | None:
    """Detect a MACD/signal crossover on the closed candle at ``index``.

    Uses Pine Script ``ta.crossover`` / ``ta.crossunder`` semantics on the histogram:
    bullish when previous <= 0 < current, bearish when previous >= 0 > current.
    A touch (previous == 0) counts as the side it is leaving, so the two are mutually
    exclusive and no epsilon is needed.
    """
    if index <= 0 or index >= len(calculated):
        return None
    previous_row = calculated.iloc[index - 1]
    current_row = calculated.iloc[index]
    required = [previous_row["histogram"], current_row["histogram"]]
    if any(pd.isna(value) for value in required):
        return None
    previous = float(previous_row["histogram"])
    current = float(current_row["histogram"])
    if previous <= 0 < current:
        return Cross("bullish", point_from_row(previous_row), point_from_row(current_row))
    if previous >= 0 > current:
        return Cross("bearish", point_from_row(previous_row), point_from_row(current_row))
    return None


def bullish_cross_at(calculated: pd.DataFrame, index: int) -> Cross | None:
    """Bullish-only view of :func:`cross_at`, kept for v1 callers and tests."""
    cross = cross_at(calculated, index)
    return cross if cross is not None and cross.direction == "bullish" else None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def event_id(symbol: str, timeframe_minutes: int, bar_open: datetime, direction: Direction = "bullish") -> str:
    stamp = bar_open.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{symbol}:{timeframe_minutes}m:{stamp}:{direction}"
