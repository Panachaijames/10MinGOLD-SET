from __future__ import annotations

import unittest

from backend.supabase_repo import SupabaseSink


class SupabaseSinkTests(unittest.TestCase):
    def test_alert_row_maps_v1_alert_to_cloud_schema(self) -> None:
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
        row = SupabaseSink.alert_row(alert)
        self.assertEqual(row["source"], "gold_mt5")
        self.assertEqual(row["timeframe"], 10)
        self.assertEqual(row["bar_time"], "2026-09-08T03:10:00Z")
        self.assertEqual(row["direction"], "bearish")
        self.assertEqual(row["title"], "XAUUSDm M10: bearish MACD cross")
        self.assertIn("crossed below signal at 2,412.35", row["body"])
        self.assertIn("closed 10:20 ICT", row["body"])
        self.assertEqual(row["payload"], {"first_tick_at": "2026-09-08T03:20:01Z"})
        self.assertEqual(row["prev_macd"], 0.3)


if __name__ == "__main__":
    unittest.main()
