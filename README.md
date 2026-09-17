# Aurum Signal

An XAUUSD-first MACD watcher for the exact `XAUUSDm` feed in the Exness MetaTrader 5 terminal. Python watches native M10 and M15 candles for **bullish and bearish** MACD crossovers; the React Progressive Web App (PWA) provides status, history, measured latency, and standards-based Web Push notifications.

This is an alert-only tool. It has no order-placement code or trading permission.

## Roadmap

Version 1 (this folder) runs everything on the laptop. The approved plan moves the PWA to Vercel and the always-on parts (SET stock polling via the TradingView scanner, push fan-out, dead-man's switch) to Supabase, with the MT5 watcher posting alerts into it. See the plan file for phases; this README documents the current laptop version.

### Phase 0 hardening (done)

- Bearish crosses alongside bullish (`ALERT_DIRECTIONS`), with direction in the event id, push title, and history; existing databases are migrated automatically (`PRAGMA user_version` 2).
- The wall-clock close fallback is **provisional**: a candle closed by the clock (daily break, Friday close) is re-evaluated when the next real candle arrives, and the watcher tracks how far the PC clock can be ahead of the broker so it never treats a still-forming candle as closed. `BAR_CLOSE_GRACE_SECONDS` defaults to 12.
- The watcher keeps Windows awake while it runs (`SetThreadExecutionState`), logs sleep/hang gaps, and `scripts/install_task.ps1` registers a Task Scheduler job that starts it at log-on and restarts it on failure.
- One process per MT5 terminal is enforced with a lock file; `scripts/check_mt5.py` refuses to run while the watcher is up.
- Benign retries (history still loading, terminal history syncing) no longer tear down the MT5 session; the push outbox thread survives database hiccups.
- Demo mode uses `backend/data/demo/` so synthetic candles never reach real devices.
- PNG icons for iOS Home Screen and Android badges; the service worker re-subscribes on `pushsubscriptionchange`.
- Logs rotate in `backend/data/logs/watcher.log`.

## What version 1 is

- **Web app, not an APK:** install it from Chrome, Edge, or Safari and it gets its own icon and standalone window. Android may create a WebAPK internally. The same React app can be wrapped as a store APK later if needed.
- **Exact Exness prices:** the watcher reads `XAUUSDm` from the MetaTrader 5 desktop terminal already signed in on this PC.
- **Confirmed signals:** it compares the last two completed candles. A forming candle is never used for the default alert, so the crossover cannot disappear before the close.
- **Low-latency path:** MT5 candle change → Python MACD → Web Push → device service worker. React rendering is not on that path.
- **Measured, not assumed:** each alert records scheduled bar close, detection, push acceptance, and service-worker receipt. The dashboard calculates median and 95th-percentile delivery time.

Normal engineering target: about **1–5 seconds after the first Exness tick following the candle close**, commonly **2–6 seconds after the clock boundary**. The first tick, network, Android Doze, iOS Focus, or a sleeping/offline device can occasionally make it longer. A ten-minute chart does **not** impose an extra ten-minute notification delay.

## Architecture

```text
Exness MT5 (XAUUSDm M10/M15)
            │ local read, every 500 ms
            ▼
Python watcher ── SQLite alert history
            │ encrypted Web Push (VAPID)
            ▼
Browser push service ── phone / tablet / laptop PWA
```

The full candle history is only fetched when MT5 exposes a new candle. Between boundaries, the 500 ms probe requests only two bars, keeping CPU usage small.

## One-time Windows setup

Prerequisites:

1. MetaTrader 5 is installed, open, signed in to Exness, and `XAUUSDm` is visible in Market Watch.
2. Python 3.11 and Node.js 22 are installed.

From PowerShell in this folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup.ps1
```

Then edit `.env`:

- `APP_TOKEN` is generated automatically. You will type this once into each installed PWA.
- Set `VAPID_SUBJECT` to your email in `mailto:name@example.com` form. It identifies the push sender; it is not displayed in alerts.
- Leave `MT5_TERMINAL_PATH` empty if there is only one MT5 installation. Otherwise enter the complete path to `terminal64.exe`.
- Before mobile setup, change `PUBLIC_APP_URL` to the final HTTPS address from Tailscale or Cloudflare.

Start the watcher:

```powershell
.\scripts\start.ps1
```

For a laptop-only test, visit `http://localhost:8000`, enter the `APP_TOKEN`, enable notifications, and use **Send test**.

To start it automatically at every sign-in (interactive session, restart on failure, no run-time limit):

```powershell
.\scripts\install_task.ps1
```

Before relying on it, check the MT5 bridge once while the watcher is stopped:

```powershell
.\.venv\Scripts\python.exe scripts\check_mt5.py
```

## Install on phone and tablet

Push and installation require HTTPS on a phone. Plain `http://192.168...` is not a secure browser context and will not work. The lowest-cost private option is **Tailscale Serve**:

1. Install Tailscale on the Windows PC and each phone/tablet, and sign them into the same free personal tailnet.
2. Keep Aurum Signal running on `127.0.0.1:8000`.
3. On the PC run:

   ```powershell
   tailscale serve --bg localhost:8000
   tailscale serve status
   ```

4. Put the resulting `https://...ts.net/` URL into `PUBLIC_APP_URL`, restart the watcher, then open that URL on each device.
5. Android/desktop: choose **Install app**, then **Enable notifications**.
6. iPhone/iPad: Safari → Share → **Add to Home Screen**; open the installed icon, then tap **Enable notifications**. iOS/iPadOS 16.4 or newer is required.

Tailscale Serve is private to your devices, provides a valid HTTPS certificate, automatically resumes when configured with `--bg`, and its Personal plan is free. A permanent Cloudflare Tunnel is another option when you want a public hostname; keep `APP_TOKEN` strong because the login endpoint will then be Internet-accessible.

## Development mode

Run the API and the small esbuild watcher separately:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
cd frontend
npm run dev
```

The API serves the rebuilt `frontend/dist` directory; refresh the browser after a source change. To test the UI without MT5, set `DATA_SOURCE=demo`; the header clearly labels the backend source in its API state.

## Tests

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend\tests -v
cd frontend
npm run build
```

## Timeframes

The laptop watcher accepts any of M5, M10, M15, M30, H1, H4 and D1 in `TIMEFRAMES` (minutes:
`5,10,15,30,60,240,1440`). Each is a native MetaTrader 5 period, so candles come straight from the
broker with no resampling. Every extra timeframe is another poll each cycle and another card in
the dashboard, so list only the ones you trade; `10,15` remains the default.

The same set is supported in the cloud — `supabase/functions/_shared/instruments.ts` is the one
place it is defined there — and the database constrains `alerts`, `candles` and `watch_state` to
it, so the three cannot drift apart.

## Signal definition

MACD uses standard exponential moving averages with `adjust=False` (the same recursion as TradingView's Pine `ta.ema`), computed over at least `MIN_HISTORY_BARS` (260) closed candles so the seed has washed out:

- MACD = EMA(12) − EMA(26)
- signal = EMA(9) of MACD
- bullish crossover = previous histogram ≤ 0 and current histogram > 0 (Pine `ta.crossover`)
- bearish crossover = previous histogram ≥ 0 and current histogram < 0 (Pine `ta.crossunder`)

On each new MT5 current-candle timestamp, the forming candle is removed and the crossover is evaluated on closed candles only. The event ID combines symbol, timeframe, UTC candle open, and direction, so restarts cannot duplicate a notification. On first run the latest candle is seeded without sending a stale alert.

When no next candle appears (daily break, Friday close) the last candle is closed by the wall clock after `BAR_CLOSE_GRACE_SECONDS` plus the measured clock-skew allowance. That evaluation is provisional: the cursor does not move past the candle, so the first real candle afterwards re-evaluates it on final data. Any alert already sent is not repeated (same event id); a cross that only appears in the final data is still sent.

If the watcher briefly restarts, it catches a crossover up to 15 minutes old instead of silently losing it. Longer outages advance the cursor without producing a burst of obsolete notifications; the gap and the number of skipped crosses are logged and shown in `/api/status`.

## Operational notes

- Keep Windows and MetaTrader 5 running; start the watcher with `scripts/start.ps1` or the scheduled task. The watcher keeps the laptop awake while it runs, but it cannot override lid-close: keep the lid open or set the lid action to "Do nothing", and stay on AC power.
- Never run a second MT5 Python client (including `scripts/check_mt5.py`) while the watcher is running; the lock file makes the second one exit.
- The watcher reconnects with exponential backoff if MT5 becomes unavailable.
- **Changing broker changes two settings.** Gold is named differently on every server, so set
  `MT5_SYMBOL` to the name in Market Watch (Wisdom Financial calls it `GOLD.wis`, Exness used
  `XAUUSDm`); a wrong name fails every cycle with "MT5 symbol is unavailable". MT5 also stamps bars
  in the broker's own timezone and never says which one, so the watcher measures it from the first
  tick that moves and stores it in `backend/data/mt5_server_offset.json`, re-checking hourly so a
  broker DST change needs no restart. Wisdom Financial runs at UTC+3; Exness ran at UTC. The
  measurement needs a trading market: on a closed weekend with no stored value the watcher says so
  and waits, or set `MT5_SERVER_UTC_OFFSET_HOURS` in `.env` to skip the wait. Session hours are
  broker-specific too: Wisdom gold trades Sunday 22:00 to Friday 21:00 UTC with a 21:00-22:00 break,
  which the cloud gate in `ops.gold_market_open()` encodes.
- Runtime state lives in `backend/data/watcher.sqlite3`; the VAPID private key is `backend/data/vapid_private_key.pem`; logs rotate in `backend/data/logs/`. All are ignored by Git. Back up the key and database if you do not want devices to resubscribe after a reinstall.
- Never put MT5 login credentials in the React app or repository. This project relies on the existing signed-in terminal session.
- Use **Send test** after installing every device. Keep an MT5-native notification as a temporary backup while comparing delivery behavior for the first week.

## Phase 2: SET stocks with DAOL SEC

DAOL SEC does not currently expose SET equity market data through Settrade Open API. Real-time alerts therefore use TradingView Essential plus the SET exchange add-on: create one two-direction webhook alert per symbol and timeframe, and send those webhooks into this alert history. The nine configured symbols are EA, KCE, BGRIM, GPSC, IVL, STA, STGT, TOP, and CCET. Gold stays on the broker's own MT5 feed whenever the laptop is online.

## Cost comparison (checked September 2026)

| Option | Up-front | Ongoing | Fit for this project |
|---|---:|---:|---|
| Existing Windows PC + React PWA + Tailscale | $0 | $0 software, plus electricity | **Best first version.** Exact broker feed and the code is already built. |
| Supabase cloud failover (`gold-scan`) | $0 | $0 on the free tiers | **Always-on safety net.** Spot-gold candles, so signals are close but not identical to the broker chart. |
| Broker Windows VPS | $0 if the account is eligible | $0 while eligibility is maintained | Best $0 always-on upgrade with exact broker data; check eligibility in the client portal. |
| AWS Lightsail Windows, 2 GB | $0 setup | $22/month | Predictable always-on fallback with enough RAM for MT5 + Python. |
| MQL5 virtual hosting | $0 setup | $15/month, less on long terms | **Not compatible with this Python PWA watcher.** It only becomes relevant after rewriting the watcher as an MQL5 EA. |
| TradingView for nine SET stocks | $0 setup | $14.95/month effective when Essential is annual ($12.95 + $2 SET data) | Best real-time-alert route with DAOL; 18 technical alerts cover 9 stocks × 2 timeframes. |

References: [Tailscale Personal pricing](https://tailscale.com/pricing), [Exness VPS](https://www.exness.com/vps/), [AWS Lightsail Windows bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [MQL5 VPS pricing](https://www.mql5.com/en/vps), [TradingView plans](https://www.tradingview.com/pricing/), and [TradingView SET data fees](https://www.tradingview.com/data-coverage/).

## Watchlist: any symbol, any timeframe, no setup

Anyone who can sign in can search for an instrument and add it to their own watchlist on M5, M10,
M15, M30, H1, H4 or D1. The cloud scanner then watches it for MACD crossovers. Nothing is
configured per symbol anywhere: no TradingView alert, no webhook, no Pine script, no change to
this repository.

- **The list is per person.** Alerts for an instrument go only to the devices of the people
  watching it, so a guest adding twenty symbols does not notify anybody else. The scan itself is
  shared: ten people watching PTT M15 cost one read, not ten.
- **Charts come with it.** An added instrument appears in the chart pane dropdown with the same
  MACD, RSI and alert arrows as gold.
- **The caps are in the database, not the UI** (`watchlist_max_per_user`, default 20;
  `watchlist_max_instruments`, default 80 distinct instruments across everyone), so they hold even
  against a hand-written request.

The honest limitation is data, not code: **SET stocks on the anonymous feed are 15 minutes
delayed**, so a self-service SET alert arrives about 15 minutes after the candle closes. Crypto,
FX and US equities come through in real time. The owner's hand-made TradingView webhook alerts stay
real time for the nine configured SET symbols, and because both producers build the same alert id,
a bar covered by both is delivered once.

Timeframes were measured against the live service rather than assumed: 1, 3, 5, 15, 30, 45, 60,
120, 240 and 1D all resolve for an anonymous session, while 10 is refused as a paid "custom
resolution". M10 is therefore built from complete pairs of M5 bars, which is what the gold failover
has always done.

## Chart

The PWA has selectable one-, two-, and four-pane candlestick layouts with full-screen mode. Every
chart includes MACD, signal, histogram, RSI(14), and matching alert arrows. Gold is available on
whichever timeframes `TIMEFRAMES` lists, each configured SET stock on M15, Binance BTCUSDT on M10
and M15, and every watchlist instrument on its own timeframe. The local API serves
gold; in cloud mode all series come from the generic `candles` table and update through Supabase
Realtime. `market-candles` stores closed TradingView OHLC for SET and Bitcoin. SET chart data is the
anonymous exchange feed and is therefore 15 minutes delayed; Bitcoin is refreshed after each close.
Axis times are shown in Bangkok time, and badges distinguish LIVE, CLOSED, and DELAYED CLOSE prices.

## Version 2: Vercel + Supabase (cloud fan-out)

Everything that must be always-on moves to Supabase; the laptop only reads Exness candles and
uploads alerts. The code for all of it is in this repo (`supabase/`, `frontend/src/backend.ts`,
`backend/supabase_repo.py`); the steps below need your Supabase and Vercel accounts.

See [`docs/DATABASE_SYNC.md`](docs/DATABASE_SYNC.md) for the table-by-table ownership, retention,
deduplication and synchronization contract.

1. **Supabase project** (region `ap-southeast-1`, current Postgres). In the dashboard copy the
   `sb_publishable_…` and `sb_secret_…` keys (Settings > API keys). Then from this folder:

   ```powershell
   npx supabase@2.116.0 login
   npx supabase@2.116.0 link --project-ref <ref>
   npx supabase@2.116.0 db push
   ```

   In the SQL editor store the two secrets the cron jobs read:

   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('sb_secret_...', 'fn_secret_key');
   ```

2. **Edge Functions.** Generate VAPID keys once (any machine with Deno, or a JWK export of the
   existing `backend/data/vapid_private_key.pem`), then:

   ```powershell
   npx supabase@2.116.0 secrets set VAPID_KEYS_JWK='{"publicKey":{...},"privateKey":{...}}' VAPID_SUBJECT=mailto:you@example.com PUBLIC_APP_URL=https://<your-app>/
   npx supabase@2.116.0 functions deploy push-fanout set-scan market-candles push-receipt gold-scan tv-webhook watch-scan symbol-search
   ```

   `verify_jwt = false` for these functions is already in `supabase/config.toml`; the functions check
   the secret key (cron, trigger, laptop) or the user JWT (PWA "Send test") themselves. Neither
   `gold-scan` nor `market-candles` needs a market-data API key.

3. **One user.** Dashboard > Authentication > Users > Add user (email + password, confirmed), then
   Authentication > Sign In / Providers > turn **off** "Allow new users to sign up".

4. **PWA on Vercel.** Import the repo, root directory `frontend`, framework "Other" (settings are in
   `frontend/vercel.json`), environment variables `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `VAPID_PUBLIC_KEY` (base64url of the VAPID public key). Decide the final domain **before** enrolling
   any device: push subscriptions, the service worker scope and the iOS Home Screen app are per origin.
   On a desktop, open **Phone QR** and scan it with each device; the QR always uses the current public
   origin and contains no login or session data. Install from the opened page, enroll notifications,
   and use **Send test**. A localhost QR is only a preview and cannot be opened by another device.

5. **Laptop → cloud.** In `.env` set `PUSH_MODE=cloud`, `SUPABASE_URL=https://<ref>.supabase.co`,
   `SUPABASE_SECRET_KEY=sb_secret_...`, restart the scheduled task. Alerts now land in `public.alerts`
   and the `push-fanout` function delivers them; `heartbeats.gold_mt5` refreshes every 15 s and the
   SQL watchdog raises a system alert if it stops during gold hours. Never run `local` and `cloud`
   against the same devices at once (duplicate notifications).

   Before enrolling any cloud push device, copy existing local history once with
   `python scripts/sync_history.py` (preview) and `python scripts/sync_history.py --apply`. The
   command refuses to run when an enabled cloud subscription could receive old alerts.

6. **SET stocks, real time via TradingView alerts.** The scanner endpoint `set-scan` polls is
   anonymous, so it serves 15-minute delayed data whatever the account pays for. Real-time SET
   needs a TradingView plan that can fire webhooks (Essential, $12.95/month billed annually) plus
   the exchange's own real-time add-on ($2.00/month for non-professionals, bought under Account >
   Market data). Alerts then fire from your own session at the candle close and post to
   `tv-webhook`, which writes the same alert row `set-scan` would have written.

   ```powershell
   npx supabase@2.116.0 secrets set TV_WEBHOOK_SECRET=<a long random string>
   ```

   Paste [docs/aurum-macd-alert.pine](docs/aurum-macd-alert.pine) into the Pine Editor, add it to
   the chart, put the same secret in its "Webhook secret" input, then create one alert per symbol
   per timeframe: condition **Aurum Signal MACD > Any alert() function call**, and under
   Notifications tick **Webhook URL** with
   `https://<ref>.supabase.co/functions/v1/tv-webhook`. Two-factor authentication must be enabled
   on the TradingView account or webhooks are refused. One alert covers both directions, so the nine
   symbols on M10 and M15 use eighteen of Essential's twenty technical alerts.

   The cron job `aurum-set-scan` keeps running with `set_scan_dry_run = true`: it still fills
   `set_macd_history` and `set_state`, but no longer raises alerts. Both alert producers build the
   same id for a given bar, so if you ever turn the webhook off and set `set_scan_dry_run = false`,
   alerting falls back to the delayed scanner with no duplicates in between. Separately,
   `aurum-set-candles` writes the nine delayed M15 OHLC series for the PWA, respecting weekdays,
   `set_holidays`, and SET session hours. `aurum-bitcoin-candles` refreshes BTCUSDT M10/M15 all week.

   Checks: `heartbeats.set_tv_webhook` updates on every alert received and shows
   `detection_delay_ms`; the PWA's Cloud health panel shows it as "TradingView alert". The
   watchdog raises a system alert if no webhook arrives for three days during SET sessions, which
   is the symptom of an expired alert or a changed webhook URL.

7. **Gold cloud failover.** `gold-scan` keeps alerts arriving while the laptop and MT5 are off.
   `ops.gold_scan_gate()` only posts to the function when `heartbeats.gold_mt5` has been quiet for
   `gold_cloud_takeover_seconds`, so the broker feed always wins when it is available. Leave
   `gold_cloud_dry_run = true` for a session and read `heartbeats.gold_cloud.details.summary`, then
   set `gold_cloud_dry_run = false` and `gold_cloud_enabled = true`. Force a one-off run with
   `?force=1`.

   Two cron jobs drive it. `aurum-gold-scan` fires ON each candle boundary (:00 :10 :15 :20 :30 :40
   :45 :50 UTC) and the function itself waits out `gold_cloud_settle_ms` before reading the feed, so
   an alert row usually lands about four seconds after the candle closes rather than a minute later.
   `aurum-gold-scan-catchup` runs a minute behind and only picks up bars the fast run missed: a
   timeframe counts as handled once its `candles` row exists, so a failed or slow run is retried and
   a successful one is never fetched twice. Watch `fetches` and `waited_ms` in the heartbeat summary
   for a session; if `fetches` is always 1, `gold_cloud_settle_ms` can come down towards 1000.

   Its candles are `OANDA:XAUUSD` prices read through TradingView's chart socket, not the broker's
   own execution feed, so it remains a stand-in rather than an exact copy. Unlike the former Twelve
   Data source, the OANDA series observes the nightly session gap and tracks the Wisdom chart more
   closely. Keep the dry run enabled for a full session before arming it. Failover alerts carry
   `source = 'gold_cloud'`, and their payload records `feed = 'oanda_via_tradingview'`.

   TradingView's chart socket is an unofficial protocol and can change. Both candle functions report
   failures through `heartbeats`; a socket failure never fabricates a candle or reuses a partial M10
   bucket.

8. **Watchlists (self-service symbols).** Nothing to configure: `db push` creates the tables and
   the two cron jobs, and deploying `watch-scan` and `symbol-search` completes it. Members add
   instruments in the PWA's Watchlist panel.

   ```powershell
   npx supabase@2.116.0 functions deploy watch-scan symbol-search
   ```

   Controls live in `public.settings`: `watchlist_enabled` (kill switch), `watchlist_dry_run`
   (detect and chart without notifying), `watchlist_max_per_user` (20), `watchlist_max_instruments`
   (80 distinct instruments across everyone), `watchlist_settle_ms` and `watchlist_batch_size`.
   Raise the caps only with the free tier in mind: each distinct instrument is one chart-socket
   read per candle, so eighty M5 instruments is eighty reads every five minutes.

   Checks: `heartbeats.watchlist` carries the last run's instrument count, alert count and a
   per-instrument summary; `public.watch_state.last_error` names an instrument the feed refused.
   The watchdog raises a system alert if no scan completes for 45 minutes while somebody is
   watching an intraday instrument. Force a run with
   `select ops.watch_scan_gate(false);` or by calling the function with `?force=1`.

9. **Keep the Free project awake.** Cron-only traffic may not count as activity; the laptop's weekday
   inserts help, and a twice-weekly external REST ping (GitHub Actions) is the belt-and-braces option.

Useful checks: `select * from cron.job_run_details order by start_time desc limit 20;`,
`select * from net._http_response order by created desc limit 10;`, Edge Function logs in the dashboard,
and the "Cloud health" panel in the PWA.
