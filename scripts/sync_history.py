from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import Settings  # noqa: E402
from backend.supabase_repo import SupabaseSink  # noqa: E402


def read_local_alerts(path: Path) -> list[dict]:
    """Read alert history without opening SQLite for writes or running migrations."""
    if not path.exists():
        raise FileNotFoundError(f"Local watcher database does not exist: {path}")
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute("SELECT * FROM alerts ORDER BY created_at").fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill existing local XAU alert history into the configured Supabase project."
    )
    parser.add_argument("--apply", action="store_true", help="Perform the upload; otherwise only report the plan.")
    parser.add_argument(
        "--allow-push",
        action="store_true",
        help="Allow the backfill when enabled cloud push subscriptions exist (old alerts may notify devices).",
    )
    args = parser.parse_args()

    settings = Settings.from_env()
    database_path = settings.data_dir / "watcher.sqlite3"
    local_alerts = read_local_alerts(database_path)
    print(f"Local alerts available for idempotent backfill: {len(local_alerts)}")
    if not args.apply:
        print("Dry run only. Re-run with --apply after checking the count.")
        return 0
    if not local_alerts:
        print("Nothing to upload.")
        return 0

    sink = SupabaseSink(settings.supabase_url, settings.supabase_secret_key)
    subscriptions = (
        sink.client.table("push_subscriptions")
        .select("endpoint", count="exact")
        .eq("enabled", True)
        .limit(1)
        .execute()
    )
    active_subscriptions = int(subscriptions.count or 0)
    if active_subscriptions and not args.allow_push:
        raise RuntimeError(
            f"Refusing to backfill with {active_subscriptions} enabled cloud push subscription(s). "
            "Disable them first or explicitly pass --allow-push."
        )

    rows = [sink.alert_row(alert) for alert in local_alerts]
    result = sink.client.table("alerts").upsert(
        rows,
        on_conflict="id",
        ignore_duplicates=True,
    ).execute()
    inserted = len(result.data or [])
    print(f"Backfill accepted: {len(rows)}; newly inserted: {inserted}; duplicates skipped: {len(rows) - inserted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
