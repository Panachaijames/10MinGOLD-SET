from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pandas as pd

from backend.market_data import MT5Source, MarketDataError


class FakeTerminal:
    """The slice of the MetaTrader5 module the source touches, on a UTC+3 server."""

    TIMEFRAME_M10 = 10
    TIMEFRAME_M15 = 15

    def __init__(self, offset_hours: float = 3.0, ticking: bool = True, server: str = "WisdomFinancial-Server"):
        self.offset = offset_hours * 3600.0
        self.ticking = ticking
        self.server = server
        self.frozen_at = time.time()
        self._msc = 0

    def account_info(self):
        return SimpleNamespace(server=self.server)

    def symbol_info_tick(self, symbol: str):
        stamp = time.time() if self.ticking else self.frozen_at
        if self.ticking:
            self._msc += 1
        return SimpleNamespace(time=int(stamp + self.offset), time_msc=int((stamp + self.offset) * 1000) + self._msc)

    def symbol_select(self, symbol: str, enable: bool) -> bool:
        return True

    def terminal_info(self):
        return SimpleNamespace(connected=True)

    def copy_rates_from_pos(self, symbol: str, timeframe: int, start: int, count: int):
        opens = pd.date_range(end=pd.Timestamp.now(tz="UTC").floor("10min"), periods=count, freq="10min")
        return [
            {"time": int(stamp.timestamp() + self.offset), "open": 4300.0, "high": 4301.0, "low": 4299.0, "close": 4300.5}
            for stamp in opens
        ]

    def last_error(self):
        return (1, "Success")


def _source(terminal: FakeTerminal, **kwargs) -> MT5Source:
    source = MT5Source(min_bars=1, **kwargs)
    source._mt5 = terminal
    source._connected = True
    return source


class ServerClockTests(unittest.TestCase):
    def test_bar_times_are_moved_from_server_time_to_utc(self) -> None:
        source = _source(FakeTerminal(offset_hours=3.0))
        frame = source.bars("GOLD.wis", 10, 5)
        newest = frame["time"].iloc[-1]
        # The newest bar opened within the last ten minutes, not three hours into the future.
        self.assertLess(abs((pd.Timestamp.now(tz="UTC") - newest).total_seconds()), 600)
        self.assertEqual(source.server_utc_offset_hours, 3.0)

    def test_offset_is_rounded_to_a_real_timezone(self) -> None:
        source = _source(FakeTerminal(offset_hours=2.0))
        self.assertEqual(source._offset_seconds_for("GOLD.wis"), 7200.0)

    def test_configured_offset_skips_measurement(self) -> None:
        terminal = FakeTerminal(offset_hours=3.0)
        terminal.symbol_info_tick = MagicMock(side_effect=AssertionError("must not probe"))
        source = _source(terminal, server_utc_offset_hours=3.0)
        self.assertEqual(source._offset_seconds_for("GOLD.wis"), 10800.0)

    def test_a_frozen_tick_never_produces_an_offset(self) -> None:
        source = _source(FakeTerminal(offset_hours=3.0, ticking=False))
        with self.assertRaises(MarketDataError) as caught:
            source.bars("GOLD.wis", 10, 5)
        self.assertIn("MT5_SERVER_UTC_OFFSET_HOURS", str(caught.exception))

    def test_closed_market_falls_back_to_the_stored_offset(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "mt5_server_offset.json"
            cache.write_text(json.dumps({"offset_seconds": 10800.0, "server": "WisdomFinancial-Server"}))
            source = _source(FakeTerminal(ticking=False), offset_cache_path=cache)
            self.assertEqual(source._offset_seconds_for("GOLD.wis"), 10800.0)

    def test_a_new_broker_discards_the_stored_offset(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "mt5_server_offset.json"
            cache.write_text(json.dumps({"offset_seconds": 0.0, "server": "Exness-MT5Real"}))
            source = _source(FakeTerminal(offset_hours=3.0), offset_cache_path=cache)
            self.assertEqual(source._offset_seconds_for("GOLD.wis"), 10800.0)
            self.assertEqual(json.loads(cache.read_text())["server"], "WisdomFinancial-Server")

    def test_a_measurement_is_reused_without_probing_again(self) -> None:
        terminal = FakeTerminal(offset_hours=3.0)
        source = _source(terminal)
        self.assertEqual(source._offset_seconds_for("GOLD.wis"), 10800.0)
        terminal.ticking = False
        self.assertEqual(source._offset_seconds_for("GOLD.wis"), 10800.0)


if __name__ == "__main__":
    unittest.main()
