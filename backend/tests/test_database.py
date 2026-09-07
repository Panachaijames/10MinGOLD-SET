from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.database import Database


V1_SCHEMA = """
CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    timeframe_minutes INTEGER NOT NULL,
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
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO alerts VALUES ('XAUUSDm:10m:20260101T000000Z:bullish','XAUUSDm',10,'2026-01-01T00:00:00Z',
    '2026-01-01T00:10:00Z',2300,0.1,0.2,0.3,0.25,0.05,'2026-01-01T00:10:01Z','2026-01-01T00:10:00Z',1000,
    '2026-01-01T00:10:01Z');
"""


def _alert(identifier: str, direction: str) -> dict:
    return {
        "id": identifier,
        "symbol": "XAUUSDm",
        "timeframe_minutes": 10,
        "direction": direction,
        "bar_open": "2026-01-01T00:10:00Z",
        "bar_close": "2026-01-01T00:20:00Z",
        "price": 2300.0,
        "previous_macd": 0.1,
        "previous_signal": 0.2,
        "macd": 0.3,
        "signal": 0.25,
        "histogram": 0.05,
        "detected_at": "2026-01-01T00:20:01Z",
        "first_tick_at": "2026-01-01T00:20:00Z",
        "detection_delay_ms": 1000,
        "created_at": "2026-01-01T00:20:01Z",
    }


class DatabaseMigrationTests(unittest.TestCase):
    def test_v1_database_gains_direction_column_without_losing_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "watcher.sqlite3"
            raw = sqlite3.connect(path)
            try:
                raw.executescript(V1_SCHEMA)
            finally:
                raw.close()  # the context manager only commits; Windows cannot delete an open file

            database = Database(path)

            self.assertEqual(database.schema_version(), Database.SCHEMA_VERSION)
            raw = sqlite3.connect(path)
            try:
                columns = {row[1] for row in raw.execute("PRAGMA table_info(alerts)")}
                legacy = raw.execute("SELECT direction FROM alerts").fetchone()[0]
            finally:
                raw.close()
            self.assertIn("direction", columns)
            self.assertEqual(legacy, "bullish")

            # Both directions on the same candle are distinct events and both persist.
            self.assertTrue(database.insert_alert(_alert("XAUUSDm:10m:20260101T001000Z:bearish", "bearish")))
            self.assertFalse(database.insert_alert(_alert("XAUUSDm:10m:20260101T001000Z:bearish", "bearish")))
            listed = {row["id"]: row["direction"] for row in database.list_alerts()}
            self.assertEqual(listed["XAUUSDm:10m:20260101T001000Z:bearish"], "bearish")
            self.assertEqual(listed["XAUUSDm:10m:20260101T000000Z:bullish"], "bullish")

            # Re-opening is idempotent.
            Database(path)
            self.assertEqual(database.schema_version(), Database.SCHEMA_VERSION)

    def test_fresh_database_is_current_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Database(Path(directory) / "fresh.sqlite3")
            self.assertEqual(database.schema_version(), Database.SCHEMA_VERSION)
            self.assertTrue(database.insert_alert(_alert("XAUUSDm:10m:20260101T001000Z:bullish", "bullish")))
            self.assertEqual(database.list_alerts()[0]["direction"], "bullish")


if __name__ == "__main__":
    unittest.main()
