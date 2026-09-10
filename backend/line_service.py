from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
import urllib.error
import urllib.request

from .config import Settings

logger = logging.getLogger(__name__)

BANGKOK = timezone(timedelta(hours=7))
LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"


def bangkok_clock(iso_value: str) -> str:
    """Render an ISO-8601 UTC timestamp as HH:MM Bangkok time."""
    try:
        parsed = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return str(iso_value)
    return parsed.astimezone(BANGKOK).strftime("%H:%M")


class LineNotifier:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.channel_access_token = settings.line_channel_access_token
        self.user_id = settings.line_user_id

    @property
    def is_configured(self) -> bool:
        return bool(self.channel_access_token and self.user_id)

    def format_alert_text(self, alert: dict[str, Any]) -> str:
        direction = str(alert.get("direction", "bullish")).lower()
        symbol = str(alert.get("symbol", "XAUUSDm"))
        timeframe = alert.get("timeframe_minutes", 10)
        price = alert.get("price")
        price_str = f"{price:,.2f}" if isinstance(price, (int, float)) else str(price)

        bar_close_clock = bangkok_clock(alert.get("bar_close", ""))

        if direction == "bullish":
            emoji = "🟢"
            dir_text = "BULLISH"
            verb = "crossed ABOVE"
        elif direction == "bearish":
            emoji = "🔴"
            dir_text = "BEARISH"
            verb = "crossed BELOW"
        else:
            emoji = "ℹ️"
            dir_text = direction.upper()
            verb = "signal"

        lines = [
            f"{emoji} AURUM SIGNAL: {symbol} M{timeframe}",
            f"Direction: {dir_text} MACD Cross ({verb})",
            f"Price: {price_str}",
            f"Bar Closed: {bar_close_clock} ICT (Bangkok)",
        ]

        macd = alert.get("macd")
        signal = alert.get("signal")
        hist = alert.get("histogram")
        if all(isinstance(v, (int, float)) for v in (macd, signal, hist)):
            lines.append(f"MACD: {macd:+.4f} | Sig: {signal:+.4f} | Hist: {hist:+.4f}")

        app_url = (self.settings.public_app_url or "").rstrip("/")
        if app_url and not app_url.startswith("http://localhost"):
            lines.append(f"Chart: {app_url}/?alert={alert.get('id', '')}")

        return "\n".join(lines)

    def send_alert(self, alert: dict[str, Any]) -> dict[str, Any]:
        if not self.is_configured:
            logger.debug("LINE notification skipped: LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID not set")
            return {"ok": False, "reason": "not_configured"}

        text = self.format_alert_text(alert)
        return self._post_message(text)

    def send_test(self) -> dict[str, Any]:
        if not self.is_configured:
            return {"ok": False, "reason": "not_configured", "message": "LINE credentials are not configured"}

        now_bkk = datetime.now(timezone.utc).astimezone(BANGKOK).strftime("%Y-%m-%d %H:%M:%S ICT")
        text = (
            "🔔 Aurum Signal: LINE Notification Test\n"
            "Status: Connected successfully!\n"
            f"Source: {self.settings.data_source.upper()} ({self.settings.mt5_symbol})\n"
            f"Time: {now_bkk}\n"
            "You will receive confirmed MACD crossover alerts here."
        )
        return self._post_message(text)

    def _post_message(self, text: str) -> dict[str, Any]:
        if not self.channel_access_token or not self.user_id:
            return {"ok": False, "reason": "not_configured"}

        payload = {
            "to": self.user_id,
            "messages": [
                {
                    "type": "text",
                    "text": text,
                }
            ],
        }

        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.channel_access_token}",
            "User-Agent": "AurumSignal-Bot/1.0",
        }

        req = urllib.request.Request(LINE_PUSH_URL, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                status_code = response.getcode()
                response_body = response.read().decode("utf-8")
                logger.info("LINE push delivered successfully: HTTP %s", status_code)
                return {"ok": True, "status": status_code, "response": response_body}
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            logger.error("LINE push HTTP error %s: %s", exc.code, error_body)
            return {"ok": False, "error": f"HTTP {exc.code}", "details": error_body}
        except Exception as exc:
            logger.error("LINE push network error: %s", exc)
            return {"ok": False, "error": str(exc)}
