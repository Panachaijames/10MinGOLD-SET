from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from backend.config import Settings
from backend.database import Database
from backend.push_service import PushService, bangkok_clock, push_topic


class PushServiceTests(unittest.TestCase):
    def _service(self, root: Path) -> tuple[PushService, Database]:
        settings = replace(
            Settings.from_env(),
            data_dir=root,
            public_app_url="https://watcher.example.test/",
        )
        database = Database(root / "test.sqlite3")
        database.upsert_subscription(
            {
                "endpoint": "https://push.example.test/subscription/one",
                "keys": {"p256dh": "p" * 87, "auth": "a" * 22},
            },
            "test-browser",
        )
        return PushService(settings, database), database

    def test_test_push_is_declarative_and_records_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service, database = self._service(Path(directory))

            with patch("backend.push_service.webpush") as mocked:
                result = service.broadcast_test()

            self.assertEqual(result, {"subscriptions": 1, "accepted": 1, "failed": 0})
            payload = json.loads(mocked.call_args.kwargs["data"])
            self.assertEqual(payload["web_push"], 8030)
            self.assertEqual(payload["notification"]["navigate"], "https://watcher.example.test/")
            self.assertNotIn("app_badge", payload["notification"])
            self.assertEqual(mocked.call_args.kwargs["headers"]["Urgency"], "high")
            self.assertNotIn("Topic", mocked.call_args.kwargs["headers"])
            self.assertTrue(
                database.acknowledge_delivery(
                    payload["deliveryId"], payload["receiptToken"], "2026-01-01T00:00:01Z"
                )
            )

    def test_alert_push_carries_direction_topic_and_bangkok_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            service, database = self._service(Path(directory))
            alert = {
                "id": "XAUUSDm:10m:20260908T031000Z:bearish",
                "symbol": "XAUUSDm",
                "timeframe_minutes": 10,
                "direction": "bearish",
                "bar_open": "2026-09-08T03:10:00Z",
                "bar_close": "2026-09-08T03:20:00Z",
                "price": 2412.35,
                "previous_macd": 0.3, "previous_signal": 0.2,
                "macd": 0.1, "signal": 0.2, "histogram": -0.1,
                "detected_at": "2026-09-08T03:20:02Z",
                "first_tick_at": "2026-09-08T03:20:01Z",
                "detection_delay_ms": 2000,
                "created_at": "2026-09-08T03:20:02Z",
            }
            database.insert_alert(alert)

            with patch("backend.push_service.webpush") as mocked:
                result = service.broadcast_alert(alert)

            self.assertEqual(result["accepted"], 1)
            payload = json.loads(mocked.call_args.kwargs["data"])
            self.assertEqual(payload["notification"]["title"], "XAUUSDm M10: bearish MACD cross")
            self.assertIn("crossed below signal at 2,412.35", payload["notification"]["body"])
            self.assertIn("closed 10:20 ICT", payload["notification"]["body"])
            self.assertEqual(payload["direction"], "bearish")
            self.assertEqual(payload["notification"]["tag"], "xauusdm-m10-bear")
            self.assertTrue(payload["notification"]["navigate"].endswith("/?alert=XAUUSDm:10m:20260908T031000Z:bearish"))
            self.assertEqual(mocked.call_args.kwargs["headers"]["Topic"], "xauusdm-m10-bear")
            self.assertEqual(mocked.call_args.kwargs["ttl"], service.settings.push_ttl_seconds)

    def test_helpers(self) -> None:
        self.assertEqual(bangkok_clock("2026-09-08T03:20:00Z"), "10:20")
        self.assertEqual(push_topic("XAUUSDm", 15, "bullish"), "xauusdm-m15-bull")
        self.assertLessEqual(len(push_topic("SET:PTT.LONG-SYMBOL-NAME", 15, "bearish")), 32)
        self.assertNotIn(":", push_topic("SET:PTT", 15, "bullish"))


if __name__ == "__main__":
    unittest.main()
