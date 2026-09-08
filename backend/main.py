from __future__ import annotations

import base64
import logging
import secrets
import threading
import time
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings
from .database import Database
from .instance_lock import InstanceLockedError, acquire_instance_lock
from .market_data import make_source
from .push_service import PushService
from .watcher import Watcher


settings = Settings.from_env()
settings.data_dir.mkdir(parents=True, exist_ok=True)
_log_dir = settings.data_dir.parent / "logs" if settings.data_dir.name == "demo" else settings.data_dir / "logs"
_log_dir.mkdir(parents=True, exist_ok=True)
_log_format = "%(asctime)s %(levelname)s %(name)s: %(message)s"
logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO), format=_log_format)
# The scheduled task runs hidden, so keep a rotating file log next to the database (5 MB x 5).
_file_handler = RotatingFileHandler(_log_dir / "watcher.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter(_log_format))
logging.getLogger().addHandler(_file_handler)
logger = logging.getLogger(__name__)

PUSH_HOST_SUFFIXES = (
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
)
_test_push_lock = threading.Lock()
_last_test_push_at = 0.0

try:
    _instance_lock = acquire_instance_lock(settings.data_dir / "watcher.lock")
except InstanceLockedError as exc:
    raise SystemExit(str(exc)) from exc
database = Database(settings.data_dir / "watcher.sqlite3")
push_service = PushService(settings, database)
if settings.push_mode == "cloud":
    from .supabase_repo import SupabaseSink

    alert_sink: Any = SupabaseSink(settings.supabase_url, settings.supabase_secret_key)
    logger.info("PUSH_MODE=cloud: alerts and heartbeats go to Supabase; pushes are sent by push-fanout")
else:
    alert_sink = push_service
watcher = Watcher(settings, database, make_source(settings), alert_sink)


@asynccontextmanager
async def lifespan(_: FastAPI):
    watcher.start()
    yield
    watcher.stop()


app = FastAPI(title="XAUUSD MACD Watcher", version="0.1.0", lifespan=lifespan)


def require_token(x_app_token: Annotated[str | None, Header()] = None) -> None:
    if not x_app_token or not secrets.compare_digest(x_app_token, settings.app_token):
        raise HTTPException(status_code=401, detail="Invalid app token")


class SubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=80, max_length=128)
    auth: str = Field(min_length=16, max_length=64)


class SubscriptionBody(BaseModel):
    endpoint: str = Field(min_length=20, max_length=4096)
    keys: SubscriptionKeys


class UnsubscribeBody(BaseModel):
    endpoint: str = Field(min_length=20, max_length=4096)


class RotateBody(BaseModel):
    old_endpoint: str = Field(alias="oldEndpoint", min_length=20, max_length=4096)
    subscription: SubscriptionBody


class ReceiptBody(BaseModel):
    delivery_id: str = Field(alias="deliveryId")
    receipt_token: str = Field(alias="receiptToken", min_length=16)
    received_at: str = Field(alias="receivedAt")


def _decode_web_push_key(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid Web Push key encoding") from exc


def validate_subscription(body: SubscriptionBody) -> None:
    parsed = urlsplit(body.endpoint)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    try:
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid push endpoint port") from exc
    allowed_host = any(
        hostname == suffix or hostname.endswith(f".{suffix}") for suffix in PUSH_HOST_SUFFIXES
    )
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or not allowed_host
    ):
        raise HTTPException(status_code=422, detail="Unrecognized browser push-service endpoint")

    public_key = _decode_web_push_key(body.keys.p256dh)
    auth_secret = _decode_web_push_key(body.keys.auth)
    if len(public_key) != 65 or public_key[0] != 4 or len(auth_secret) < 16:
        raise HTTPException(status_code=422, detail="Invalid Web Push subscription keys")


@app.get("/api/health")
def health() -> dict[str, Any]:
    snapshot = watcher.snapshot()
    return {
        "ok": bool(snapshot["running"]) and bool(snapshot["delivery_alive"]),
        "feed_connected": bool(snapshot["connected"]),
        "delivery_alive": bool(snapshot["delivery_alive"]),
        "keep_awake": bool(snapshot["keep_awake"]),
        "last_poll_at": snapshot["last_poll_at"],
        "pending_pushes": database.outbox_pending_count(),
        "server_time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/api/public-config")
def public_config() -> dict[str, Any]:
    return {
        "vapid_public_key": push_service.public_key,
        "symbol": settings.mt5_symbol,
        "timeframes": settings.timeframes,
        "poll_interval_ms": round(settings.poll_interval_seconds * 1000),
    }


@app.get("/api/status", dependencies=[Depends(require_token)])
def status() -> dict[str, Any]:
    return {
        "watcher": watcher.snapshot(),
        "subscriptions": database.subscription_count(),
        "pending_pushes": database.outbox_pending_count(),
        "latency": database.latency_summary(),
    }


@app.get("/api/alerts", dependencies=[Depends(require_token)])
def alerts(limit: int = 50) -> dict[str, Any]:
    return {"alerts": database.list_alerts(max(1, min(limit, 200)))}


@app.get("/api/candles", dependencies=[Depends(require_token)])
def candles(timeframe: int = 10, limit: int = 200) -> dict[str, Any]:
    if timeframe not in settings.timeframes:
        raise HTTPException(status_code=404, detail=f"Unknown timeframe M{timeframe}")
    rows = watcher.candles(timeframe)
    return {
        "symbol": settings.mt5_symbol,
        "timeframe_minutes": timeframe,
        "candles": rows[-max(1, min(limit, 500)):],
    }


@app.post("/api/push/subscriptions", dependencies=[Depends(require_token)])
def subscribe(body: SubscriptionBody, request: Request) -> dict[str, Any]:
    validate_subscription(body)
    user_agent = (request.headers.get("user-agent") or "")[:500]
    subscription_id = database.upsert_subscription(body.model_dump(), user_agent)
    return {"ok": True, "subscription_id": subscription_id}


@app.delete("/api/push/subscriptions", dependencies=[Depends(require_token)])
def unsubscribe(body: UnsubscribeBody) -> dict[str, bool]:
    database.disable_subscription(body.endpoint)
    return {"ok": True}


@app.post("/api/push/subscriptions/rotate")
def rotate_subscription(body: RotateBody, request: Request) -> dict[str, Any]:
    """Called by the service worker on `pushsubscriptionchange`, which has no app token.

    Possession of the previous (long, random, server-known) endpoint URL is the proof of
    ownership; the new subscription is validated exactly like a normal subscribe.
    """
    if not database.subscription_exists(body.old_endpoint):
        raise HTTPException(status_code=404, detail="Unknown previous subscription")
    validate_subscription(body.subscription)
    user_agent = (request.headers.get("user-agent") or "")[:500]
    subscription_id = database.upsert_subscription(body.subscription.model_dump(), user_agent)
    if body.subscription.endpoint != body.old_endpoint:
        database.disable_subscription(body.old_endpoint)
    return {"ok": True, "subscription_id": subscription_id}


@app.post("/api/push/test", dependencies=[Depends(require_token)])
def test_push() -> dict[str, Any]:
    global _last_test_push_at
    with _test_push_lock:
        now = time.monotonic()
        if now - _last_test_push_at < 10:
            raise HTTPException(status_code=429, detail="Wait 10 seconds before sending another test")
        _last_test_push_at = now
    return {"ok": True, **push_service.broadcast_test()}


@app.post("/api/push/receipts")
def push_receipt(body: ReceiptBody) -> dict[str, bool]:
    try:
        received = datetime.fromisoformat(body.received_at.replace("Z", "+00:00"))
        if received.tzinfo is None:
            raise ValueError("timezone missing")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="receivedAt must be an ISO-8601 timestamp with timezone") from exc
    ok = database.acknowledge_delivery(body.delivery_id, body.receipt_token, body.received_at)
    if not ok:
        raise HTTPException(status_code=404, detail="Unknown delivery receipt")
    return {"ok": True}


if settings.frontend_dist.exists():
    assets_dir = settings.frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        requested = (settings.frontend_dist / full_path).resolve()
        dist = settings.frontend_dist.resolve()
        if requested.is_relative_to(dist) and requested.is_file():
            return FileResponse(requested)
        return FileResponse(settings.frontend_dist / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def frontend_not_built() -> dict[str, str]:
        return {"message": "Frontend not built yet. Run npm install && npm run build in frontend/."}
