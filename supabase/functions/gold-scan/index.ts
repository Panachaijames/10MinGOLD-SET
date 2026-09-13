// Gold failover scanner: MACD crossovers on CLOSED 10m and 15m OANDA candles fetched through
// TradingView's chart socket, so alerts keep arriving while the laptop (and MT5) is off.
//
// OANDA's session structure is closer to the broker feed than the old generic spot feed. It is
// still a failover, not a replacement: pg_cron invokes it through ops.gold_scan_gate(), which
// only posts here when the laptop heartbeat has gone quiet, so the two producers never race for
// the same bar. Manual run: ?force=1.
//
// Timing: cron fires ON the candle boundary and this function does the sub-minute waiting,
// which puts an alert in the table a handful of seconds after the candle closes rather than
// the best part of a minute. A second cron run a minute later re-tries anything missed.
import { isSecretCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { bangkokClock, crossDirection, eventId, macdSeries, type Direction } from "../_shared/macd.ts";
import { fetchClosedBars } from "../_shared/tradingview.ts";

const FEED = "oanda_via_tradingview";
const FEED_SYMBOL = "OANDA:XAUUSD";
// MACD(12,26,9) needs a long warm-up before the EMA seed washes out; the laptop uses 260 too.
const MIN_CLOSED_BARS = 260;
const CANDLE_HISTORY = 200;
// cron can only fire on whole minutes, so it fires ON the boundary and the waiting happens
// here: settle, then re-ask a few times if the provider has not published the closed bar yet.
const RETRY_DELAYS_MS = [3_000, 5_000, 8_000];
// Whole-invocation budget for waiting. It stays well inside the caller's timeout, and a bar
// that misses it is simply left for the catch-up run rather than risking a killed isolate.
const WAIT_BUDGET_MS = 25_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Bar {
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function loadClosedBars(timeframe: number, nowMs: number): Promise<Bar[]> {
  if (timeframe !== 10 && timeframe !== 15) throw new Error(`Unsupported gold timeframe: ${timeframe}`);
  const bars = await fetchClosedBars(FEED_SYMBOL, timeframe, MIN_CLOSED_BARS + 60, nowMs);
  return bars.map((bar) => ({
    openMs: bar.time * 1000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
}

/** Open time of the candle that has just closed: the newest boundary, minus one timeframe. */
export function expectedClosedBarOpen(timeframe: number, nowMs: number): number {
  const step = timeframe * 60_000;
  // cron can fire a moment early, so anything within five seconds of a boundary is past it.
  return Math.floor((nowMs + 5_000) / step) * step - step;
}

/**
 * Wait for the candle that just closed, then return the series ending on it.
 *
 * Asking the instant the boundary passes risks reading a close the provider is still
 * aggregating, so the first fetch waits out a settle window; after that the bar is either
 * there or it is re-asked a few times. Returns null when it never appeared, which leaves no
 * candle row behind, so the catch-up run a minute later tries the same bar again.
 */
export async function awaitClosedBar(
  timeframe: number,
  expectedOpenMs: number,
  settleMs: number,
  budgetEndsAt: number,
  entry: Record<string, unknown>,
  load: (timeframe: number, nowMs: number) => Promise<Bar[]> = loadClosedBars,
): Promise<Bar[] | null> {
  const closedAt = expectedOpenMs + timeframe * 60_000;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const waitMs = attempt === 0
      ? Math.max(0, closedAt + settleMs - Date.now())
      : RETRY_DELAYS_MS[attempt - 1];
    if (Date.now() + waitMs > budgetEndsAt) break;
    if (waitMs > 0) await sleep(waitMs);
    const bars = await load(timeframe, Date.now());
    entry.fetches = attempt + 1;
    if (bars.length && bars[bars.length - 1].openMs === expectedOpenMs) {
      entry.waited_ms = Date.now() - closedAt;
      return bars;
    }
    if (Date.now() >= budgetEndsAt) break;
  }
  return null;
}

function renderAlert(symbol: string, timeframe: number, direction: Direction, bar: Bar, point: {
  macd: number;
  signal: number;
  histogram: number;
}, previous: { macd: number; signal: number }) {
  const barOpen = new Date(bar.openMs);
  const barClose = new Date(bar.openMs + timeframe * 60_000);
  const verb = direction === "bullish" ? "crossed above" : "crossed below";
  const price = bar.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: eventId(symbol, timeframe, barOpen, direction),
    source: "gold_cloud",
    symbol,
    timeframe,
    direction,
    bar_time: barOpen.toISOString(),
    bar_close: barClose.toISOString(),
    price: bar.close,
    macd: point.macd,
    signal: point.signal,
    histogram: point.histogram,
    prev_macd: previous.macd,
    prev_signal: previous.signal,
    title: `${symbol} M${timeframe}: ${direction} MACD cross`,
    body: `MACD ${verb} signal at ${price} (candle closed ${bangkokClock(barClose)} ICT · OANDA via TradingView, laptop offline)`,
    detected_at: new Date().toISOString(),
    detection_delay_ms: Math.max(0, Date.now() - barClose.getTime()),
    payload: {
      feed: FEED,
      feed_symbol: FEED_SYMBOL,
      venue: "OANDA",
      via: "tradingview_chart_socket",
      failover: true,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!isSecretCaller(req)) return unauthorized();

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const client = adminClient();
  const startedAt = Date.now();

  const enabled = await getSetting<boolean>(client, "gold_cloud_enabled", false);
  if (!enabled && !force) return Response.json({ skipped: "gold_cloud_enabled is false" });
  const dryRun = await getSetting<boolean>(client, "gold_cloud_dry_run", true);
  const symbol = await getSetting<string>(client, "gold_symbol", "GOLD.wis");
  const maxAgeSeconds = await getSetting<number>(client, "gold_cloud_max_age_seconds", 900);
  const settleMs = await getSetting<number>(client, "gold_cloud_settle_ms", 3000);
  const directions = new Set(await getSetting<Direction[]>(client, "alert_directions", ["bullish", "bearish"]));
  const requested: number[] = Array.isArray(body?.timeframes) && body.timeframes.length
    ? body.timeframes.map(Number)
    : [10, 15];

  const budgetEndsAt = startedAt + WAIT_BUDGET_MS;
  const summary: Record<string, unknown>[] = [];
  try {
    for (const timeframe of requested) {
      const entry: Record<string, unknown> = { timeframe };
      const expectedOpenMs = expectedClosedBarOpen(timeframe, Date.now());
      entry.expected_bar_open = new Date(expectedOpenMs).toISOString();
      const bars = await awaitClosedBar(timeframe, expectedOpenMs, settleMs, budgetEndsAt, entry);
      if (bars === null) {
        // No candle row is written, so ops.gold_scan_gate() sees the bar as unhandled and the
        // catch-up cron run asks again a minute later.
        entry.result = "bar-not-published";
        summary.push(entry);
        continue;
      }
      if (bars.length < MIN_CLOSED_BARS) {
        entry.result = `too-few-bars:${bars.length}`;
        summary.push(entry);
        continue;
      }
      const series = macdSeries(bars.map((bar) => bar.close));
      const last = bars.length - 1;
      const bar = bars[last];
      const point = series[last];
      entry.bar_open = new Date(bar.openMs).toISOString();
      entry.histogram = point.histogram;

      // A bar that closed long ago means cron resumed after an outage, not a fresh signal.
      const ageSeconds = (Date.now() - (bar.openMs + timeframe * 60_000)) / 1000;
      const direction = crossDirection(series[last - 1].histogram, point.histogram);
      entry.result = direction ?? "no-cross";
      if (direction && !directions.has(direction)) entry.result = `muted:${direction}`;
      else if (direction && ageSeconds > maxAgeSeconds) entry.result = `stale:${Math.round(ageSeconds)}s`;
      else if (direction) {
        const alert = renderAlert(symbol, timeframe, direction, bar, point, series[last - 1]);
        entry.alert_id = alert.id;
        if (dryRun) {
          entry.dry_run = true;
        } else {
          const { error } = await client.from("alerts").upsert(alert, { onConflict: "id", ignoreDuplicates: true });
          if (error) entry.insert_error = error.message;
        }
      }

      // Chart rows, so the PWA does not flatline while the laptop is off. ignoreDuplicates
      // keeps the broker's own candles authoritative: the cloud only fills the gaps.
      const from = Math.max(0, bars.length - CANDLE_HISTORY);
      const history = bars.slice(from).map((row, index) => {
        const macd = series[from + index];
        return {
          symbol,
          timeframe,
          bar_time: new Date(row.openMs).toISOString(),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          macd: macd.macd,
          signal: macd.signal,
          histogram: macd.histogram,
          provisional: false,
        };
      });
      const { error: candleError } = await client
        .from("candles")
        .upsert(history, { onConflict: "symbol,timeframe,bar_time", ignoreDuplicates: true });
      if (candleError) entry.candle_error = candleError.message;
      summary.push(entry);
    }

    await heartbeat(client, "gold_cloud", true, {
      symbol,
      feed: FEED,
      feed_symbol: FEED_SYMBOL,
      venue: "OANDA",
      via: "tradingview_chart_socket",
      dry_run: dryRun,
      settle_ms: settleMs,
      timeframes: requested,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: true, dry_run: dryRun, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await heartbeat(client, "gold_cloud", false, {
      error: message,
      feed: FEED,
      feed_symbol: FEED_SYMBOL,
      venue: "OANDA",
      via: "tradingview_chart_socket",
      timeframes: requested,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({ ok: false, error: message, summary }, { status: 502 });
  }
});
