from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch
import pandas as pd

from backend.market_data import TwelveDataSource, MarketDataError


class TwelveDataSourceTests(unittest.TestCase):
    def test_symbol_mapping(self) -> None:
        source = TwelveDataSource(api_key="mock_key", default_symbol="XAU/USD")
        self.assertEqual(source._map_symbol("XAUUSDm"), "XAU/USD")
        self.assertEqual(source._map_symbol("XAUUSD"), "XAU/USD")
        self.assertEqual(source._map_symbol("EURUSD"), "EURUSD")

    @patch.object(TwelveDataSource, "_fetch_series")
    def test_bars_15m_returns_directly(self, mock_fetch: MagicMock) -> None:
        mock_df = pd.DataFrame([
            {
                "time": pd.Timestamp("2026-09-10 15:00:00", tz="UTC"),
                "open": 2890.0,
                "high": 2895.0,
                "low": 2888.0,
                "close": 2894.0,
                "tick_volume": 100,
            }
        ])
        mock_fetch.return_value = mock_df

        source = TwelveDataSource(api_key="mock_key", min_bars=1)
        bars = source.bars("XAUUSDm", 15, 1)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars.iloc[0]["close"], 2894.0)
        mock_fetch.assert_called_once_with("XAU/USD", "15min", 1)

    @patch.object(TwelveDataSource, "_fetch_series")
    def test_bars_10m_resamples_from_5m(self, mock_fetch: MagicMock) -> None:
        # Four 5-minute bars:
        # Bar 1: 15:00:00 (O: 2890, H: 2892, L: 2889, C: 2891)
        # Bar 2: 15:05:00 (O: 2891, H: 2895, L: 2890, C: 2894)
        # -> Should combine into M10 bar at 15:00:00 (O: 2890, H: 2895, L: 2889, C: 2894)
        #
        # Bar 3: 15:10:00 (O: 2894, H: 2896, L: 2893, C: 2895)
        # Bar 4: 15:15:00 (O: 2895, H: 2898, L: 2892, C: 2897)
        # -> Should combine into M10 bar at 15:10:00 (O: 2894, H: 2898, L: 2892, C: 2897)
        rows_5m = [
            {
                "time": pd.Timestamp("2026-09-10 15:00:00", tz="UTC"),
                "open": 2890.0,
                "high": 2892.0,
                "low": 2889.0,
                "close": 2891.0,
                "tick_volume": 50,
            },
            {
                "time": pd.Timestamp("2026-09-10 15:05:00", tz="UTC"),
                "open": 2891.0,
                "high": 2895.0,
                "low": 2890.0,
                "close": 2894.0,
                "tick_volume": 60,
            },
            {
                "time": pd.Timestamp("2026-09-10 15:10:00", tz="UTC"),
                "open": 2894.0,
                "high": 2896.0,
                "low": 2893.0,
                "close": 2895.0,
                "tick_volume": 70,
            },
            {
                "time": pd.Timestamp("2026-09-10 15:15:00", tz="UTC"),
                "open": 2895.0,
                "high": 2898.0,
                "low": 2892.0,
                "close": 2897.0,
                "tick_volume": 80,
            },
        ]
        mock_fetch.return_value = pd.DataFrame(rows_5m)

        source = TwelveDataSource(api_key="mock_key", min_bars=2)
        bars_10m = source.bars("XAUUSDm", 10, 2)
        self.assertEqual(len(bars_10m), 2)

        first_bar = bars_10m.iloc[0]
        self.assertEqual(first_bar["time"], pd.Timestamp("2026-09-10 15:00:00", tz="UTC"))
        self.assertEqual(first_bar["open"], 2890.0)
        self.assertEqual(first_bar["high"], 2895.0)
        self.assertEqual(first_bar["low"], 2889.0)
        self.assertEqual(first_bar["close"], 2894.0)
        self.assertEqual(first_bar["tick_volume"], 110)

        second_bar = bars_10m.iloc[1]
        self.assertEqual(second_bar["time"], pd.Timestamp("2026-09-10 15:10:00", tz="UTC"))
        self.assertEqual(second_bar["open"], 2894.0)
        self.assertEqual(second_bar["high"], 2898.0)
        self.assertEqual(second_bar["low"], 2892.0)
        self.assertEqual(second_bar["close"], 2897.0)
        self.assertEqual(second_bar["tick_volume"], 150)
