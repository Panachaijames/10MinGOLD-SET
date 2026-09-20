# Supabase database and sync contract

Supabase is the cloud source of truth for the installed PWA. The Windows database remains a
durable local safety layer so a network or Supabase outage cannot make the MT5 watcher forget a
closed candle or lose a confirmed crossover.

## Table map

| Table | Written by | Read by | Retention and purpose |
|---|---|---|---|
| `alerts` | Windows gold watcher, later TradingView/SET ingestion, watchdog | PWA, push fan-out | Permanent trading-signal history. Deterministic `id` and a unique source/symbol/timeframe/bar/direction key make retries safe. |
| `candles` | Windows gold watcher, `gold-scan`, `market-candles`, `watch-scan` | PWA chart | OHLC and MACD for every charted instrument, upserted by symbol, timeframe and UTC bar-open time. Retention is 400 bars' worth of the timeframe and never less than 14 days, so an H4 or D1 chart is not truncated to a fortnight. |
| `heartbeats` | Windows watcher and Edge Functions | PWA, watchdog | One frequently-upserted row per component (`gold_mt5`, `gold_cloud`, `set_tv`, `market_candles`, `push_fanout`); no growing heartbeat log. |
| `push_subscriptions` | Authenticated PWA | `push-fanout` | One current browser endpoint and key pair per installed device. Disabled when a push service reports that it is gone. |
| `push_deliveries` | `push-fanout`, `push-receipt` | PWA latency/status | Per-alert/per-device delivery state and receipt timestamps; purged after 30 days. |
| `set_state` | SET ingestion/scanner | PWA, SET scanner | Latest MACD state and cursor per stock **and timeframe**. Composite key `(symbol,timeframe)` supports M10 and M15. |
| `set_macd_history` | SET scanner | Scanner state/diagnostics | Per-bar delayed scanner values retained for 60 days; PWA candlesticks now read OHLC from `candles`. |
| `set_holidays` | Owner | SET session gate | Thai market closures; update annually from an authoritative calendar. |
| `settings` | Owner and server jobs | Edge Functions and SQL jobs | Tickers, kill switches, dry-run flags, alert directions, session settings, watchlist caps and push TTL. |
| `watchlist` | Each member, through the PWA | `watch-scan`, `push-fanout` | One row per member per instrument and timeframe. RLS restricts every member to their own rows; database triggers enforce `watchlist_max_per_user` and `watchlist_max_instruments`. |
| `notification_prefs` | Each member, through the PWA | `push-fanout` | One row per member: quiet-hours window, its timezone, and a LINE destination when they have one. RLS restricts every member to their own row. |
| `watch_state` | `watch-scan` | PWA watchlist panel, scan gate | Scanner cursor per **distinct** `(symbol,timeframe)`, not per member: one scan serves everyone watching the same instrument. Purged a week after nobody watches it. |

## What is synchronized

### Windows to Supabase

- A heartbeat snapshot every 15 seconds: connection state, latest poll, errors and M10/M15 cards.
- The most recent 200 closed candles per timeframe after a bar transition. Upserts make provisional
  session-close bars safe to correct when the next real MT5 bar arrives.
- Confirmed bullish or bearish MACD events. The event is committed to SQLite and its durable local
  outbox first; only a successful Supabase insert completes that outbox item. Network failures use
  bounded exponential retry.

Existing locally completed alerts are a one-time exception: preview them with
`python scripts/sync_history.py`, then use `python scripts/sync_history.py --apply` before enrolling
cloud push devices. The command is idempotent and refuses to backfill while enabled cloud devices
exist unless that safeguard is explicitly overridden.

### PWA to Supabase

- Login/session through Supabase Auth.
- Browser Web Push subscription registration, renewal and disablement.
- Delivery receipt acknowledgements through the `push-receipt` Edge Function.
- Reads of alert history, current status, chart candles and SET state. Realtime invalidates the UI;
  Web Push remains the closed-app notification mechanism.

### Supabase internal flow

1. Inserting an `alerts` row invokes `push-fanout` asynchronously.
2. Fan-out creates one idempotent `push_deliveries` row per enabled device and sends Web Push.
3. The service worker posts its one-time receipt token to `push-receipt`.
4. A two-minute sweep retries transiently failed pending deliveries; the watchdog detects stale
   components; weekly cleanup enforces retention.

### Watchlist flow

`watch-scan` is a generic version of `gold-scan`: it reads closed candles for an instrument from
TradingView's anonymous chart socket, computes MACD(12,26,9) itself, and inserts an alert on a
crossover. Nothing is configured per symbol, which is what lets a member add an instrument in the
PWA and be alerted on it without the owner creating a TradingView alert.

`ops.watch_scan_gate()` runs every five minutes, selects the instruments whose timeframe divides
the tick (H4 and D1 are polled hourly, because on a session-bounded market their bars do not close
on an epoch-aligned boundary), and chunks them across invocations. A catch-up run two minutes later
picks up only what a failed or timed-out invocation left behind, judged by `watch_state.last_polled_at`.

Routing is the part that differs from every other producer, and it is where every personal
preference is applied. A `watchlist` alert is **not** a broadcast: `push-fanout` looks up who
watches that `(symbol,timeframe)` and then filters that list through each member's own rules —
`watchlist.notify` (muted), `watchlist.directions` (a direction they do not trade),
`notification_prefs` quiet hours (judged in their timezone) — before creating delivery rows.
`watchlist.channels` then decides push, LINE, or both, with each member's LINE destination coming
from `notification_prefs.line_user_id` and the owner's from the function's `LINE_USER_ID` secret.

Detection is deliberately impersonal: one scan serves everyone watching an instrument, so the
scanner cannot apply anybody's preferences without applying them to everybody. It therefore writes
the alert for **both** directions regardless of `alert_directions` (which still governs gold and
SET), and suppression happens at delivery. An alert nobody wanted pushed is still stored, charted
and listed. Alert ids are identical to those the real-time TradingView webhook builds for the same
bar, so an instrument covered by both is notified once.

Delayed venues identify themselves: the feed reports `delay` (900 seconds for SET and TFEX), which
the scanner applies to its own clock before deciding whether a bar has closed, and names in the
alert text. Dated futures contracts identify themselves too, through `expiration`: once that day
has passed the contract can never print another candle, so the scan records why on
`watch_state.last_error` instead of leaving a watchlist entry that silently never signals. Daily bars on session markets close when the exchange does, read from the feed's session
string, rather than 24 hours after the bar opened.

### SET and Bitcoin chart flow

TradingView webhook alerts write the normalized `alerts` shape while the delayed scanner maintains
`set_state`/`set_macd_history`. The `market-candles` Edge Function independently stores the nine SET
M15 OHLC series and Binance BTCUSDT M10/M15 in `candles`; cron gates SET by its Bangkok session and
keeps Bitcoin running 24/7. `source`, `symbol`, `timeframe`, `direction`, `bar_time`, and deterministic
event IDs prevent duplicate notifications.

## Data deliberately kept off Supabase

- Exness/MT5 login, password, account number, positions, balance and order permissions.
- Raw tick history or the entire MT5 terminal database.
- The local last-processed-candle cursor and local retry mechanics.
- Local logs and Windows scheduling/lock state.

The Windows process currently uses a Supabase secret key because it is controlled server-side code,
never browser code. Keep that key only in the ignored `.env`; the PWA receives only the publishable
key. Row Level Security grants anonymous users nothing and allows the single authenticated owner to
read app state and manage only their own push subscriptions.
