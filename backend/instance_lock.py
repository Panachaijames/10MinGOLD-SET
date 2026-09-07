from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import IO


class InstanceLockedError(RuntimeError):
    pass


def acquire_instance_lock(path: Path, attempts: int = 5, wait_seconds: float = 1.0) -> IO[str]:
    """Hold an exclusive file lock for the life of the returned handle.

    The MetaTrader5 package tolerates only one Python client per terminal and two outbox
    workers would double-send, so any second process that wants the terminal must fail
    fast instead of degrading the running watcher.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+", encoding="utf-8")
    if handle.tell() == 0:
        handle.write("lock\n")
        handle.flush()
    for attempt in range(attempts):
        try:
            handle.seek(0)
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            if attempt == attempts - 1:
                handle.close()
                raise InstanceLockedError(
                    f"Another Aurum Signal process already holds {path}. "
                    "Only one process may talk to the MT5 terminal; stop the other one first."
                )
            time.sleep(wait_seconds)
    raise AssertionError("unreachable")
