from __future__ import annotations

import json
from dataclasses import replace
from io import BytesIO
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from backend.config import Settings
from backend.line_service import LineNotifier, bangkok_clock


class LineServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base_settings = Settings.from_env()

    def test_is_configured(self) -> None:
        unconfigured_settings = replace(
            self.base_settings,
            line_channel_access_token="",
            line_user_id="",
        )
        unconfigured = LineNotifier(unconfigured_settings)
        self.assertFalse(unconfigured.is_configured)
        self.assertEqual(unconfigured.send_alert({"id": "test"})["ok"], False)

        configured_settings = replace(
            self.base_settings,
            line_channel_access_token="test_token",
            line_user_id="U1234567890",
        )
        configured = LineNotifier(configured_settings)
        self.assertTrue(configured.is_configured)

    def test_format_bullish_alert(self) -> None:
        settings = replace(
            self.base_settings,
            line_channel_access_token="test_token",
            line_user_id="U1234567890",
            public_app_url="https://gold-macd.vercel.app/",
        )
        notifier = LineNotifier(settings)
        alert = {
            "id": "XAUUSDm-10-2026-09-10T15:00:00Z-bullish",
            "symbol": "XAUUSDm",
            "timeframe_minutes": 10,
            "direction": "bullish",
            "price": 2895.40,
            "bar_close": "2026-09-10T15:00:00Z",
            "macd": 0.245,
            "signal": 0.12,
            "histogram": 0.125,
        }
        text = notifier.format_alert_text(alert)
        self.assertIn("🟢 AURUM SIGNAL: XAUUSDm M10", text)
        self.assertIn("BULLISH MACD Cross", text)
        self.assertIn("2,895.40", text)
        self.assertIn("22:00 ICT", text)
        self.assertIn("https://gold-macd.vercel.app/?alert=", text)

    def test_format_bearish_alert(self) -> None:
        notifier = LineNotifier(self.base_settings)
        alert = {
            "id": "XAUUSDm-15-2026-09-10T15:00:00Z-bearish",
            "symbol": "XAUUSDm",
            "timeframe_minutes": 15,
            "direction": "bearish",
            "price": 2890.10,
            "bar_close": "2026-09-10T15:00:00Z",
            "macd": -0.15,
            "signal": -0.05,
            "histogram": -0.10,
        }
        text = notifier.format_alert_text(alert)
        self.assertIn("🔴 AURUM SIGNAL: XAUUSDm M15", text)
        self.assertIn("BEARISH MACD Cross", text)
        self.assertIn("2,890.10", text)

    @patch("urllib.request.urlopen")
    def test_send_alert_success(self, mock_urlopen: MagicMock) -> None:
        mock_resp = MagicMock()
        mock_resp.getcode.return_value = 200
        mock_resp.read.return_value = b"{}"
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        settings = replace(
            self.base_settings,
            line_channel_access_token="valid_token",
            line_user_id="U1234567890",
        )
        notifier = LineNotifier(settings)
        res = notifier.send_alert({
            "symbol": "XAUUSDm",
            "timeframe_minutes": 10,
            "direction": "bullish",
            "price": 2895.0,
            "bar_close": "2026-09-10T15:00:00Z",
        })
        self.assertTrue(res["ok"])
        self.assertEqual(res["status"], 200)

        # Verify payload sent to LINE
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        payload = json.loads(req.data.decode("utf-8"))
        self.assertEqual(payload["to"], "U1234567890")
        self.assertEqual(req.headers["Authorization"], "Bearer valid_token")

    @patch("urllib.request.urlopen")
    def test_send_alert_http_error(self, mock_urlopen: MagicMock) -> None:
        error = urllib.error.HTTPError(
            url="https://api.line.me/v2/bot/message/push",
            code=401,
            msg="Unauthorized",
            hdrs={},  # type: ignore[arg-type]
            fp=BytesIO(b'{"message":"Invalid access token"}'),
        )
        mock_urlopen.side_effect = error

        settings = replace(
            self.base_settings,
            line_channel_access_token="bad_token",
            line_user_id="U1234567890",
        )
        notifier = LineNotifier(settings)
        res = notifier.send_alert({"symbol": "XAUUSDm", "price": 2800.0})
        self.assertFalse(res["ok"])
        self.assertIn("HTTP 401", res["error"])
        self.assertIn("Invalid access token", res["details"])
