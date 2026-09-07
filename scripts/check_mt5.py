"""Read-only connection check for the configured MT5 symbol and timeframes.

Run from the project folder:  .\\.venv\\Scripts\\python.exe scripts\\check_mt5.py

It refuses to run while the watcher is running: MetaTrader 5 supports only one Python
client per terminal, and a second one degrades the first.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import Settings  # noqa: E402
from backend.instance_lock import InstanceLockedError, acquire_instance_lock  # noqa: E402
from backend.market_data import make_source  # noqa: E402


def main() -> int:
    settings = Settings.from_env()
    try:
        lock = acquire_instance_lock(settings.data_dir / "watcher.lock", attempts=1)
    except InstanceLockedError as exc:
        print(f"REFUSED: {exc}")
        return 2

    source = make_source(settings)
    try:
        started = time.monotonic()
        source.connect()
        print(f"connected in {time.monotonic() - started:.1f}s; symbol={settings.mt5_symbol}; source={settings.data_source}")
        for timeframe in settings.timeframes:
            frame = source.bars(settings.mt5_symbol, timeframe, settings.history_bars)
            latest = frame.iloc[-1]
            closed = frame.iloc[-2]
            print(
                f"M{timeframe}: bars={len(frame)} (min {settings.min_history_bars}), "
                f"forming_open_utc={latest['time'].isoformat()}, last_closed_open_utc={closed['time'].isoformat()}, "
                f"close={float(closed['close']):.2f}"
            )
        return 0
    finally:
        source.close()
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
