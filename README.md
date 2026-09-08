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
2. Python 3.11 and Node.js 20 are installed.

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
- Runtime state lives in `backend/data/watcher.sqlite3`; the VAPID private key is `backend/data/vapid_private_key.pem`; logs rotate in `backend/data/logs/`. All are ignored by Git. Back up the key and database if you do not want devices to resubscribe after a reinstall.
- Never put MT5 login credentials in the React app or repository. This project relies on the existing signed-in terminal session.
- Use **Send test** after installing every device. Keep an MT5-native notification as a temporary backup while comparing delivery behavior for the first week.

## Phase 2: SET stocks with DAOL SEC

DAOL SEC does not currently expose SET equity market data through Settrade Open API, so it should not be wired into this watcher with an unofficial scraping dependency. The practical later route is TradingView Essential plus the real-time SET exchange add-on: create ten bullish crossover alerts for five symbols across M10 and M15, and send their webhooks into this same alert history. Gold remains on Exness MT5 so its prices match the account exactly.

## Cost comparison (checked September 2026)

| Option | Up-front | Ongoing | Fit for this project |
|---|---:|---:|---|
| Existing Windows PC + React PWA + Tailscale | $0 | $0 software, plus electricity | **Best first version.** Exact Exness feed and the code is already built. |
| Exness Windows VPS | $0 if the account is eligible | $0 while eligibility is maintained | Best $0 always-on upgrade; check eligibility in the Exness Personal Area. |
| AWS Lightsail Windows, 2 GB | $0 setup | $22/month | Predictable always-on fallback with enough RAM for MT5 + Python. |
| MQL5 virtual hosting | $0 setup | $15/month, less on long terms | **Not compatible with this Python PWA watcher.** It only becomes relevant after rewriting the watcher as an MQL5 EA. |
| TradingView for five SET stocks | $0 setup | $14.95/month effective when Essential is annual ($12.95 + $2 SET data) | Best phase-2 route with DAOL; 20 technical alerts cover 5 stocks × 2 timeframes. |

References: [Tailscale Personal pricing](https://tailscale.com/pricing), [Exness VPS](https://www.exness.com/vps/), [AWS Lightsail Windows bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html), [MQL5 VPS pricing](https://www.mql5.com/en/vps), [TradingView plans](https://www.tradingview.com/pricing/), and [TradingView SET data fees](https://www.tradingview.com/data-coverage/).

## Chart

The PWA draws the last 200 closed candles of the selected timeframe (M10 / M15 tabs) with a MACD pane
(histogram, MACD, signal) and marks every confirmed cross with an arrow. Data comes from the watcher:
`/api/candles?timeframe=10` locally, or the `candles` table in Supabase (published by the watcher in
cloud mode, live via Realtime). SET tickers get a MACD-only history chart from `set_macd_history`,
because the free TradingView scanner exposes indicator values but no OHLC history. Axis times are shown
in Bangkok time.

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
   npx supabase@2.116.0 functions deploy push-fanout set-scan push-receipt
   ```

   `verify_jwt = false` for all three is already in `supabase/config.toml`; the functions check the
   secret key (cron, trigger, laptop) or the user JWT (PWA "Send test") themselves.

3. **One user.** Dashboard > Authentication > Users > Add user (email + password, confirmed), then
   Authentication > Sign In / Providers > turn **off** "Allow new users to sign up".

4. **PWA on Vercel.** Import the repo, root directory `frontend`, framework "Other" (settings are in
   `frontend/vercel.json`), environment variables `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `VAPID_PUBLIC_KEY` (base64url of the VAPID public key). Decide the final domain **before** enrolling
   any device: push subscriptions, the service worker scope and the iOS Home Screen app are per origin.
   Enroll each device on the production URL and use **Send test**.

5. **Laptop → cloud.** In `.env` set `PUSH_MODE=cloud`, `SUPABASE_URL=https://<ref>.supabase.co`,
   `SUPABASE_SECRET_KEY=sb_secret_...`, restart the scheduled task. Alerts now land in `public.alerts`
   and the `push-fanout` function delivers them; `heartbeats.gold_mt5` refreshes every 15 s and the
   SQL watchdog raises a system alert if it stops during gold hours. Never run `local` and `cloud`
   against the same devices at once (duplicate notifications).

   Before enrolling any cloud push device, copy existing local history once with
   `python scripts/sync_history.py` (preview) and `python scripts/sync_history.py --apply`. The
   command refuses to run when an enabled cloud subscription could receive old alerts.

6. **SET stocks.** Edit `settings.set_tickers`, leave `set_scan_dry_run = true` for two sessions and
   read `heartbeats.set_tv.details` / `set_state` to confirm `update_mode`, the 900 s lag and bar
   timestamps, then set `set_scan_dry_run = false` and `set_scan_enabled = true`. The cron job
   `aurum-set-scan` polls at :01/:16/:31/:46/:56 UTC inside SET sessions only (gate in
   `ops.set_scan_gate()`), and `set_holidays` is editable from SQL.

7. **Keep the Free project awake.** Cron-only traffic may not count as activity; the laptop's weekday
   inserts help, and a twice-weekly external REST ping (GitHub Actions) is the belt-and-braces option.

Useful checks: `select * from cron.job_run_details order by start_time desc limit 20;`,
`select * from net._http_response order by created desc limit 10;`, Edge Function logs in the dashboard,
and the "Cloud health" panel in the PWA.
