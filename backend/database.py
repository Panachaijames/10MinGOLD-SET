from __future__ import annotations

import hashlib
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        schema = """
        CREATE TABLE IF NOT EXISTS state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            timeframe_minutes INTEGER NOT NULL,
            direction TEXT NOT NULL DEFAULT 'bullish',
            bar_open TEXT NOT NULL,
            bar_close TEXT NOT NULL,
            price REAL NOT NULL,
            previous_macd REAL NOT NULL,
            previous_signal REAL NOT NULL,
            macd REAL NOT NULL,
            signal REAL NOT NULL,
            histogram REAL NOT NULL,
            detected_at TEXT NOT NULL,
            first_tick_at TEXT NOT NULL,
            detection_delay_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts(created_at DESC);
        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            user_agent TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries (
            id TEXT PRIMARY KEY,
            alert_id TEXT,
            subscription_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            accepted_at TEXT,
            received_at TEXT,
            status TEXT NOT NULL,
            receipt_token_hash TEXT NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(alert_id) REFERENCES alerts(id),
            FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
        );
        CREATE INDEX IF NOT EXISTS deliveries_alert_idx ON deliveries(alert_id);
        CREATE TABLE IF NOT EXISTS outbox (
            alert_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY(alert_id) REFERENCES alerts(id)
        );
        CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox(status, next_attempt_at);
        """
        with self._lock, self._connection() as connection:
            connection.executescript(schema)
            self._migrate(connection)

    # Schema versions:
    #   0/1 -> v1 layout (bullish-only alerts, no direction column)
    #   2   -> alerts.direction added (bullish|bearish)
    SCHEMA_VERSION = 2

    def _migrate(self, connection: sqlite3.Connection) -> None:
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if version >= self.SCHEMA_VERSION:
            return
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(alerts)").fetchall()}
        if "direction" not in columns:
            # Pre-existing v1 databases: CREATE TABLE IF NOT EXISTS above was a no-op, so add the column.
            connection.execute("ALTER TABLE alerts ADD COLUMN direction TEXT NOT NULL DEFAULT 'bullish'")
        connection.execute(f"PRAGMA user_version = {self.SCHEMA_VERSION}")

    def schema_version(self) -> int:
        with self._lock, self._connection() as connection:
            return int(connection.execute("PRAGMA user_version").fetchone()[0])

    def get_state(self, key: str) -> str | None:
        with self._lock, self._connection() as connection:
            row = connection.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
            return str(row["value"]) if row else None

    def set_state(self, key: str, value: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """INSERT INTO state(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                (key, value, now_iso()),
            )

    def insert_alert(self, alert: dict[str, Any]) -> bool:
        fields = (
            "id", "symbol", "timeframe_minutes", "direction", "bar_open", "bar_close", "price",
            "previous_macd", "previous_signal", "macd", "signal", "histogram",
            "detected_at", "first_tick_at", "detection_delay_ms", "created_at",
        )
        values = tuple(alert.get(field, "bullish") if field == "direction" else alert[field] for field in fields)
        placeholders = ",".join("?" for _ in fields)
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                f"INSERT OR IGNORE INTO alerts({','.join(fields)}) VALUES ({placeholders})", values
            )
            inserted = cursor.rowcount == 1
            if inserted:
                connection.execute(
                    """INSERT INTO outbox(alert_id,status,attempts,next_attempt_at,created_at)
                    VALUES (?,'pending',0,?,?)""",
                    (alert["id"], alert["created_at"], alert["created_at"]),
                )
            return inserted

    def list_alerts(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """SELECT a.*,
                    SUM(CASE WHEN d.status IN ('accepted','received') THEN 1 ELSE 0 END) AS push_accepted,
                    SUM(CASE WHEN d.received_at IS NOT NULL THEN 1 ELSE 0 END) AS device_received,
                    MIN(d.received_at) AS first_device_received_at
                FROM alerts a LEFT JOIN deliveries d ON d.alert_id = a.id
                GROUP BY a.id ORDER BY a.created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]

    def upsert_subscription(self, subscription: dict[str, Any], user_agent: str | None) -> int:
        endpoint = subscription["endpoint"]
        keys = subscription["keys"]
        timestamp = now_iso()
        with self._lock, self._connection() as connection:
            connection.execute(
                """INSERT INTO subscriptions(endpoint,p256dh,auth,user_agent,enabled,created_at,last_seen_at)
                VALUES (?,?,?,?,1,?,?)
                ON CONFLICT(endpoint) DO UPDATE SET
                    p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent,
                    enabled=1, last_seen_at=excluded.last_seen_at""",
                (endpoint, keys["p256dh"], keys["auth"], user_agent, timestamp, timestamp),
            )
            row = connection.execute("SELECT id FROM subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
            return int(row["id"])

    def subscription_exists(self, endpoint: str) -> bool:
        with self._lock, self._connection() as connection:
            row = connection.execute("SELECT 1 FROM subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
            return row is not None

    def disable_subscription(self, endpoint: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute("UPDATE subscriptions SET enabled=0 WHERE endpoint=?", (endpoint,))

    def active_subscriptions(self) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT id,endpoint,p256dh,auth,user_agent FROM subscriptions WHERE enabled=1"
            ).fetchall()
            return [dict(row) for row in rows]

    def subscriptions_needing_alert(self, alert_id: str) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """SELECT s.id,s.endpoint,s.p256dh,s.auth,s.user_agent
                FROM subscriptions s
                WHERE s.enabled=1 AND NOT EXISTS (
                    SELECT 1 FROM deliveries d
                    WHERE d.alert_id=? AND d.subscription_id=s.id
                      AND d.status IN ('accepted','received')
                )""",
                (alert_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def subscription_count(self) -> int:
        with self._lock, self._connection() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM subscriptions WHERE enabled=1").fetchone()
            return int(row["count"])

    def create_delivery(
        self,
        delivery_id: str,
        alert_id: str | None,
        subscription_id: int,
        kind: str,
        receipt_token: str,
    ) -> None:
        digest = hashlib.sha256(receipt_token.encode()).hexdigest()
        with self._lock, self._connection() as connection:
            connection.execute(
                """INSERT INTO deliveries(
                    id,alert_id,subscription_id,kind,status,receipt_token_hash,created_at
                ) VALUES (?,?,?,?,?,?,?)""",
                (delivery_id, alert_id, subscription_id, kind, "pending", digest, now_iso()),
            )

    def delivery_accepted(self, delivery_id: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE deliveries SET status='accepted', accepted_at=? WHERE id=?",
                (now_iso(), delivery_id),
            )

    def delivery_failed(self, delivery_id: str, error: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE deliveries SET status='failed', error=? WHERE id=?",
                (error[:500], delivery_id),
            )

    def acknowledge_delivery(self, delivery_id: str, receipt_token: str, received_at: str) -> bool:
        digest = hashlib.sha256(receipt_token.encode()).hexdigest()
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                """UPDATE deliveries SET status='received', received_at=?
                WHERE id=? AND receipt_token_hash=?""",
                (received_at, delivery_id, digest),
            )
            return cursor.rowcount == 1

    def due_outbox_alerts(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """SELECT a.*, o.attempts AS outbox_attempts
                FROM outbox o JOIN alerts a ON a.id=o.alert_id
                WHERE o.status='pending' AND o.next_attempt_at <= ?
                ORDER BY o.created_at LIMIT ?""",
                (now_iso(), limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def complete_outbox(self, alert_id: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """UPDATE outbox SET status='completed', completed_at=?, last_error=NULL
                WHERE alert_id=?""",
                (now_iso(), alert_id),
            )

    def retry_outbox(self, alert_id: str, error: str, delay_seconds: int) -> None:
        next_attempt = datetime.now(timezone.utc) + timedelta(seconds=max(1, delay_seconds))
        next_iso = next_attempt.isoformat().replace("+00:00", "Z")
        with self._lock, self._connection() as connection:
            connection.execute(
                """UPDATE outbox SET attempts=attempts+1, next_attempt_at=?, last_error=?
                WHERE alert_id=?""",
                (next_iso, error[:500], alert_id),
            )

    def outbox_pending_count(self) -> int:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM outbox WHERE status='pending'"
            ).fetchone()
            return int(row["count"])

    def latency_summary(self) -> dict[str, int | float | None]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                """SELECT a.bar_close, d.received_at
                FROM deliveries d JOIN alerts a ON a.id=d.alert_id
                WHERE d.received_at IS NOT NULL ORDER BY d.received_at DESC LIMIT 200"""
            ).fetchall()
        values: list[float] = []
        for row in rows:
            closed = datetime.fromisoformat(row["bar_close"].replace("Z", "+00:00"))
            received = datetime.fromisoformat(row["received_at"].replace("Z", "+00:00"))
            values.append(max(0.0, (received - closed).total_seconds() * 1000))
        if not values:
            return {"samples": 0, "p50_ms": None, "p95_ms": None, "max_ms": None}
        values.sort()
        percentile = lambda fraction: values[min(len(values) - 1, round((len(values) - 1) * fraction))]
        return {
            "samples": len(values),
            "p50_ms": round(percentile(0.50)),
            "p95_ms": round(percentile(0.95)),
            "max_ms": round(max(values)),
        }
