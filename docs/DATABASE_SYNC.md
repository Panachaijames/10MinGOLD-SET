# Supabase database and sync contract

Supabase is the cloud source of truth for the installed PWA. The Windows database remains a
durable local safety layer so a network or Supabase outage cannot make the MT5 watcher forget a
closed candle or lose a confirmed crossover.

## Table map

| Table | Written by | Read by | Retention and purpose |
|---|---|---|---|
| `alerts` | Windows gold watcher, later TradingView/SET ingestion, watchdog | PWA, push fan-out | Permanent trading-signal history. Deterministic `id` and a unique source/symbol/timeframe/bar/direction key make retries safe. |
| `candles` | Windows gold watcher | PWA chart | Last 14 days of closed XAUUSDm M10/M15 OHLC and MACD values. Rows are upserted by symbol, timeframe and UTC bar-open time. |
| `heartbeats` | Windows watcher and Edge Functions | PWA, watchdog | One frequently-upserted row per component (`gold_mt5`, `set_tv`, `push_fanout`); no growing heartbeat log. |
| `push_subscriptions` | Authenticated PWA | `push-fanout` | One current browser endpoint and key pair per installed device. Disabled when a push service reports that it is gone. |
| `push_deliveries` | `push-fanout`, `push-receipt` | PWA latency/status | Per-alert/per-device delivery state and receipt timestamps; purged after 30 days. |
| `set_state` | SET ingestion/scanner | PWA, SET scanner | Latest MACD state and cursor per stock **and timeframe**. Composite key `(symbol,timeframe)` supports M10 and M15. |
| `set_macd_history` | SET ingestion/scanner | PWA chart | Per-bar SET MACD history, currently retained for 60 days. |
| `set_holidays` | Owner | SET session gate | Thai market closures; update annually from an authoritative calendar. |
| `settings` | Owner and server jobs | Edge Functions and SQL jobs | Tickers, kill switches, dry-run flag, alert directions, session settings and push TTL. |

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

### Future SET flow

TradingView or another approved SET source writes the same normalized `alerts` shape and updates
`set_state`/`set_macd_history`. `source`, `symbol`, `timeframe`, `direction`, `bar_time` and the
deterministic event id prevent duplicates. Adding SET therefore does not require another PWA or
notification system.

## Data deliberately kept off Supabase

- Exness/MT5 login, password, account number, positions, balance and order permissions.
- Raw tick history or the entire MT5 terminal database.
- The local last-processed-candle cursor and local retry mechanics.
- Local logs and Windows scheduling/lock state.

The Windows process currently uses a Supabase secret key because it is controlled server-side code,
never browser code. Keep that key only in the ignored `.env`; the PWA receives only the publishable
key. Row Level Security grants anonymous users nothing and allows the single authenticated owner to
read app state and manage only their own push subscriptions.
