from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")

# MACD(12,26,9) needs a long warm-up for the EMA seed to wash out. The seed's residual
# weight in the 26-EMA is 4.6e-4 after 100 bars and 2.1e-7 after 200; 260 keeps values
# within TradingView rounding. Fewer bars are rejected as "history still syncing".
DEFAULT_MIN_HISTORY_BARS = 260


def _csv_ints(value: str) -> tuple[int, ...]:
    values = tuple(dict.fromkeys(int(item.strip()) for item in value.split(",") if item.strip()))
    unsupported = set(values) - {10, 15}
    if unsupported:
        raise ValueError(f"Only native MT5 M10/M15 are supported, received: {sorted(unsupported)}")
    if not values:
        raise ValueError("TIMEFRAMES cannot be empty")
    return values


def _csv_directions(value: str) -> tuple[str, ...]:
    values = tuple(dict.fromkeys(item.strip().lower() for item in value.split(",") if item.strip()))
    unsupported = set(values) - {"bullish", "bearish"}
    if unsupported:
        raise ValueError(f"ALERT_DIRECTIONS accepts bullish and/or bearish, received: {sorted(unsupported)}")
    if not values:
        raise ValueError("ALERT_DIRECTIONS cannot be empty")
    return values


@dataclass(frozen=True)
class Settings:
    app_token: str
    data_source: str
    mt5_symbol: str
    mt5_terminal_path: str | None
    timeframes: tuple[int, ...]
    alert_directions: tuple[str, ...]
    poll_interval_seconds: float
    bar_close_grace_seconds: float
    history_bars: int
    min_history_bars: int
    catch_up_max_age_seconds: int
    offline_gap_alert_seconds: int
    vapid_subject: str
    push_ttl_seconds: int
    public_app_url: str
    push_mode: str
    supabase_url: str
    supabase_secret_key: str
    heartbeat_interval_seconds: float
    data_dir: Path
    frontend_dist: Path
    log_level: str
    line_channel_access_token: str | None = None
    line_user_id: str | None = None
    line_bot_id: str | None = None
    line_bot_add_url: str | None = None
    twelvedata_api_key: str | None = None
    twelvedata_symbol: str = "XAU/USD"

    @classmethod
    def from_env(cls) -> "Settings":
        data_source = os.getenv("DATA_SOURCE", "mt5").strip().lower()
        if data_source not in {"mt5", "demo", "twelvedata"}:
            raise ValueError(f"DATA_SOURCE must be 'mt5', 'demo', or 'twelvedata', received: {data_source}")

        twelvedata_api_key = os.getenv("TWELVEDATA_API_KEY", "").strip() or None
        if data_source == "twelvedata" and not twelvedata_api_key:
            raise RuntimeError("TWELVEDATA_API_KEY is required when DATA_SOURCE=twelvedata")

        data_dir_value = os.getenv("DATA_DIR", "backend/data")
        data_dir = Path(data_dir_value)
        if not data_dir.is_absolute():
            data_dir = PROJECT_ROOT / data_dir
        if data_source == "demo":
            # Demo candles must never share state, event ids or device subscriptions with
            # the live watcher, otherwise synthetic crosses reach real phones and shadow
            # the real bar with the same id.
            data_dir = data_dir / "demo"

        token = os.getenv("APP_TOKEN", "").strip()
        if not token or token == "replace-with-a-long-random-token":
            raise RuntimeError("APP_TOKEN is not configured. Run scripts/setup.ps1 or set a strong token in .env.")
        if len(token) < 24:
            raise RuntimeError("APP_TOKEN must contain at least 24 characters")

        history_bars = max(100, int(os.getenv("HISTORY_BARS", "350")))
        min_history_bars = max(60, int(os.getenv("MIN_HISTORY_BARS", str(DEFAULT_MIN_HISTORY_BARS))))
        if min_history_bars > history_bars:
            raise ValueError(
                f"MIN_HISTORY_BARS ({min_history_bars}) cannot exceed HISTORY_BARS ({history_bars})"
            )

        push_mode = os.getenv("PUSH_MODE", "local").strip().lower()
        if push_mode not in {"local", "cloud"}:
            raise ValueError("PUSH_MODE must be 'local' (pywebpush from this machine) or 'cloud' (Supabase)")

        return cls(
            app_token=token,
            data_source=data_source,
            mt5_symbol=os.getenv("MT5_SYMBOL", "XAUUSDm").strip(),
            mt5_terminal_path=os.getenv("MT5_TERMINAL_PATH", "").strip() or None,
            timeframes=_csv_ints(os.getenv("TIMEFRAMES", "10,15")),
            alert_directions=_csv_directions(os.getenv("ALERT_DIRECTIONS", "bullish,bearish")),
            poll_interval_seconds=max(0.25, float(os.getenv("POLL_INTERVAL_SECONDS", "0.5"))),
            # The wall-clock fallback only matters at the daily break and Friday close, where a
            # few seconds do not matter; a small grace lets local clock skew evaluate a bar that
            # is still forming on the server.
            bar_close_grace_seconds=max(0.0, float(os.getenv("BAR_CLOSE_GRACE_SECONDS", "12.0"))),
            history_bars=history_bars,
            min_history_bars=min_history_bars,
            catch_up_max_age_seconds=max(0, int(os.getenv("CATCH_UP_MAX_AGE_SECONDS", "900"))),
            offline_gap_alert_seconds=max(30, int(os.getenv("OFFLINE_GAP_ALERT_SECONDS", "120"))),
            vapid_subject=os.getenv("VAPID_SUBJECT", "mailto:replace-me@example.com").strip(),
            push_ttl_seconds=max(0, int(os.getenv("PUSH_TTL_SECONDS", "600"))),
            public_app_url=os.getenv("PUBLIC_APP_URL", "http://localhost:8000/").strip().rstrip("/") + "/",
            push_mode=push_mode,
            supabase_url=os.getenv("SUPABASE_URL", "").strip().rstrip("/"),
            supabase_secret_key=os.getenv("SUPABASE_SECRET_KEY", "").strip(),
            heartbeat_interval_seconds=max(5.0, float(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "15"))),
            data_dir=data_dir,
            frontend_dist=PROJECT_ROOT / "frontend" / "dist",
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
            line_channel_access_token=os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "").strip() or None,
            line_user_id=os.getenv("LINE_USER_ID", "").strip() or None,
            line_bot_id=os.getenv("LINE_BOT_ID", "").strip() or None,
            line_bot_add_url=(
                os.getenv("LINE_BOT_ADD_URL", "").strip()
                or (f"https://line.me/R/ti/p/@{os.getenv('LINE_BOT_ID', '').strip().lstrip('@')}" if os.getenv("LINE_BOT_ID", "").strip() else None)
            ),
            twelvedata_api_key=twelvedata_api_key,
            twelvedata_symbol=os.getenv("TWELVEDATA_SYMBOL", "XAU/USD").strip() or "XAU/USD",
        )
