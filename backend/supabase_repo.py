from __future__ import annotations

import logging
from typing import Any

from .push_service import bangkok_clock

logger = logging.getLogger(__name__)


class SupabaseSink:
    """Uploads confirmed alerts and heartbeats from the laptop watcher into Supabase.

    Exposes the same ``broadcast_alert`` shape as :class:`backend.push_service.PushService`
    so the watcher's outbox loop does not care where alerts go. Pushes themselves are sent
    by the ``push-fanout`` Edge Function when the row lands in ``alerts``.
    """

    source = "gold_mt5"

    def __init__(self, url: str, secret_key: str):
        from supabase import create_client  # imported lazily: only needed in cloud mode

        if not url or not secret_key:
            raise RuntimeError("PUSH_MODE=cloud needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env")
        if not secret_key.startswith("sb_secret_"):
            logger.warning("SUPABASE_SECRET_KEY does not look like a new-style sb_secret_ key")
        self.client = create_client(url, secret_key)

    @staticmethod
    def alert_row(alert: dict[str, Any]) -> dict[str, Any]:
        direction = str(alert.get("direction") or "bullish")
        verb = "crossed above" if direction == "bullish" else "crossed below"
        return {
            "id": alert["id"],
            "source": SupabaseSink.source,
            "symbol": alert["symbol"],
            "timeframe": int(alert["timeframe_minutes"]),
            "direction": direction,
            "bar_time": alert["bar_open"],
            "bar_close": alert["bar_close"],
            "price": float(alert["price"]),
            "macd": float(alert["macd"]),
            "signal": float(alert["signal"]),
            "histogram": float(alert["histogram"]),
            "prev_macd": float(alert["previous_macd"]),
            "prev_signal": float(alert["previous_signal"]),
            "title": f"{alert['symbol']} M{alert['timeframe_minutes']}: {direction} MACD cross",
            "body": (
                f"MACD {verb} signal at {float(alert['price']):,.2f} "
                f"(candle closed {bangkok_clock(alert['bar_close'])} ICT)"
            ),
            "detected_at": alert["detected_at"],
            "detection_delay_ms": int(alert.get("detection_delay_ms") or 0),
            "payload": {"first_tick_at": alert.get("first_tick_at")},
        }

    def broadcast_alert(self, alert: dict[str, Any]) -> dict[str, int]:
        row = self.alert_row(alert)
        # ignore_duplicates keeps restarts and re-fetches idempotent on the primary key.
        self.client.table("alerts").upsert(row, on_conflict="id", ignore_duplicates=True).execute()
        return {"subscriptions": 1, "accepted": 1, "failed": 0}

    def heartbeat(self, connected: bool, details: dict[str, Any]) -> None:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        self.client.table("heartbeats").upsert(
            {"source": self.source, "last_seen": now, "connected": connected, "details": details, "updated_at": now},
            on_conflict="source",
        ).execute()
