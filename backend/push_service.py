from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

from .config import Settings
from .database import Database


logger = logging.getLogger(__name__)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


BANGKOK = timezone(timedelta(hours=7))  # Asia/Bangkok has no DST


def bangkok_clock(iso_value: str) -> str:
    """Render an ISO-8601 UTC timestamp as HH:MM Bangkok time for notification text."""
    try:
        parsed = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    except ValueError:
        return iso_value
    return parsed.astimezone(BANGKOK).strftime("%H:%M")


def push_topic(symbol: str, timeframe_minutes: int, direction: str) -> str:
    """Web Push Topic header: <= 32 base64url characters, one per instrument/timeframe/direction.

    Direction is part of the topic so a queued bullish cross is never silently replaced
    by a later bearish one before the phone comes online.
    """
    raw = f"{symbol}-m{timeframe_minutes}-{direction[:4]}".lower()
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw)
    return safe[:32]


class PushService:
    def __init__(self, settings: Settings, database: Database):
        self.settings = settings
        self.database = database
        self.private_key_path = settings.data_dir / "vapid_private_key.pem"
        self.public_key = self._load_or_create_key()

    def _load_or_create_key(self) -> str:
        self.private_key_path.parent.mkdir(parents=True, exist_ok=True)
        if self.private_key_path.exists():
            private_key = serialization.load_pem_private_key(self.private_key_path.read_bytes(), password=None)
        else:
            private_key = ec.generate_private_key(ec.SECP256R1())
            pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            self.private_key_path.write_bytes(pem)
        public_bytes = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        return base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")

    def broadcast_alert(self, alert: dict[str, Any]) -> dict[str, int]:
        direction = str(alert.get("direction") or "bullish")
        verb = "crossed above" if direction == "bullish" else "crossed below"
        title = f"{alert['symbol']} M{alert['timeframe_minutes']}: {direction} MACD cross"
        body = (
            f"MACD {verb} signal at {alert['price']:,.2f} "
            f"(candle closed {bangkok_clock(alert['bar_close'])} ICT)"
        )
        topic = push_topic(alert["symbol"], int(alert["timeframe_minutes"]), direction)
        return self._broadcast(
            kind="alert",
            alert_id=alert["id"],
            subscriptions=self.database.subscriptions_needing_alert(alert["id"]),
            base_payload={
                "title": title,
                "body": body,
                "eventId": alert["id"],
                "symbol": alert["symbol"],
                "timeframe": f"M{alert['timeframe_minutes']}",
                "direction": direction,
                "barClose": alert["bar_close"],
                "detectedAt": alert["detected_at"],
                "tag": topic,
                "url": f"/?alert={alert['id']}",
            },
            topic=topic,
        )

    def broadcast_test(self) -> dict[str, int]:
        event = f"test:{uuid.uuid4()}"
        return self._broadcast(
            kind="test",
            alert_id=None,
            base_payload={
                "title": "XAUUSD watcher test",
                "body": "Web Push is connected. This device can receive alerts with the app closed.",
                "eventId": event,
                "url": "/",
            },
        )

    def _broadcast(
        self,
        kind: str,
        alert_id: str | None,
        base_payload: dict[str, Any],
        subscriptions: list[dict[str, Any]] | None = None,
        topic: str | None = None,
    ) -> dict[str, int]:
        result = {"subscriptions": 0, "accepted": 0, "failed": 0}
        if subscriptions is None:
            subscriptions = self.database.active_subscriptions()
        result["subscriptions"] = len(subscriptions)
        if not subscriptions:
            return result

        def send_one(subscription: dict[str, Any]) -> bool:
            delivery_id = str(uuid.uuid4())
            receipt_token = secrets.token_urlsafe(24)
            self.database.create_delivery(
                delivery_id, alert_id, int(subscription["id"]), kind, receipt_token
            )
            notification: dict[str, Any] = {
                "title": base_payload["title"],
                "body": base_payload["body"],
                "navigate": urljoin(self.settings.public_app_url, base_payload.get("url", "/")),
                "silent": False,
            }
            if base_payload.get("tag"):
                notification["tag"] = base_payload["tag"]
            payload = {
                # Declarative Web Push (Safari/iOS 18.4+) renders this directly; other browsers
                # hand the same JSON to the service worker's push handler. app_badge is left out
                # until it is verified on the real device (early Safari builds crashed on it).
                "web_push": 8030,
                "notification": notification,
                **base_payload,
                "deliveryId": delivery_id,
                "receiptToken": receipt_token,
                "sentAt": iso_now(),
            }
            headers = {"Urgency": "high"}
            if topic:
                headers["Topic"] = topic
            info = {
                "endpoint": subscription["endpoint"],
                "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
            }
            try:
                webpush(
                    subscription_info=info,
                    data=json.dumps(payload, separators=(",", ":")),
                    vapid_private_key=str(self.private_key_path),
                    vapid_claims={"sub": self.settings.vapid_subject},
                    ttl=self.settings.push_ttl_seconds,
                    headers=headers,
                    timeout=10,
                )
                self.database.delivery_accepted(delivery_id)
                return True
            except WebPushException as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code in {404, 410}:
                    self.database.disable_subscription(subscription["endpoint"])
                self.database.delivery_failed(delivery_id, f"HTTP {status_code}: {exc}")
                logger.warning("Push delivery failed (HTTP %s)", status_code)
                return False
            except Exception as exc:
                self.database.delivery_failed(delivery_id, str(exc))
                logger.exception("Unexpected push delivery failure")
                return False

        # One unresponsive endpoint must not serially delay every other device.
        # A small bounded pool keeps worst-case fan-out near one HTTP timeout.
        with ThreadPoolExecutor(max_workers=min(8, len(subscriptions)), thread_name_prefix="web-push") as executor:
            futures = [executor.submit(send_one, subscription) for subscription in subscriptions]
            for future in as_completed(futures):
                if future.result():
                    result["accepted"] += 1
                else:
                    result["failed"] += 1
        return result
