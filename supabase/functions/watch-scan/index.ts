// Watchlist scanner: MACD crossovers on CLOSED candles for whatever members have added.
//
// This is the same detection `gold-scan` performs, generalised to any instrument and any of the
// seven supported timeframes. It needs no per-symbol configuration anywhere — no TradingView
// alert, no webhook, no Pine script — which is the whole point: a member adds a symbol in the
// PWA and the next scan covers it.
//
// One scan serves everybody. The cursor in `watch_state` is keyed by symbol and timeframe, so
// ten members watching PTT M15 cost one socket read; the fan-out is what routes the resulting
// alert to their devices and nobody else's.
//
// Invoked by pg_cron through ops.watch_scan_gate(), which works out which instruments are due
// and chunks them. A direct call with an explicit `instruments` array scans exactly those.
import { isSecretCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { bangkokClock, crossDirection, eventId, macdSeries, type Direction } from "../_shared/macd.ts";
import {
  barCloseMs,
  fetchInstrument,
  hasExpired,
  maxAgeMs,
  parseInstruments,
  timeframeLabel,
  type ClosedSeries,
  type Instrument,
} from "../_shared/instruments.ts";

// MACD(12,26,9) needs a long warm-up before the EMA seed washes out; the laptop uses 260 too.
const MIN_CLOSED_BARS = 260;
// Chart window written when an instrument is first seen. Later scans write only the new bars.
const SEED_CANDLES = 200;
const MAX_CONCURRENCY = 4;
const MAX_INSTRUMENTS = 40;
// Whole-invocation budget, kept inside the 60-second pg_net timeout the cron gate posts with, so
// the caller always sees the result. An instrument that misses it is left for the catch-up run.
const WAIT_BUDGET_MS = 50_000;
const RETRY_DELAY_MS = 4_000;
const MAX_RETRIES = 2;

type Client = ReturnType<typeof adminClient>;

interface StateRow {
  symbol: string;
  timeframe: number;
  last_bar_time: number | null;
  last_hist: number | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** Every instrument at least one member is watching. */
async function allWatchedInstruments(client: Client): Promise<Instrument[]> {
  const { data, error } = await client.from("watchlist").select("symbol,timeframe").eq("enabled", true);
  if (error) throw new Error(`watchlist query failed: ${error.message}`);
  return parseInstruments(data ?? [], MAX_INSTRUMENTS);
}

/**
 * Whether it is worth asking the provider again inside this invocation.
 *
 * Only a real-time feed can lag behind a boundary: a delayed feed has already had its delay to
 * finish the bar. The window is deliberately narrow — a newer bar is overdue, but not so overdue
 * that the market is simply shut, which is the normal state of an equity feed at night.
 */
export function shouldRetry(
  series: ClosedSeries,
  timeframe: number,
  state: StateRow | undefined,
  feedNowMs: number,
): boolean {
  if (series.delaySeconds > 0) return false;
  if (!series.bars.length || state?.last_bar_time == null) return false;
  const newest = series.bars[series.bars.length - 1].time;
  if (newest !== Number(state.last_bar_time)) return false;
  const step = timeframe * 60_000;
  const since = feedNowMs - newest * 1000;
  return since >= 2 * step && since < 4 * step;
}

function renderAlert(
  instrument: Instrument,
  direction: Direction,
  bar: { time: number; close: number },
  point: { macd: number; signal: number; histogram: number },
  previous: { macd: number; signal: number },
  series: ClosedSeries,
) {
  const { symbol, timeframe } = instrument;
  const shortSymbol = symbol.replace(/^[A-Z0-9_]+:/, "");
  const frame = timeframeLabel(timeframe);
  const barOpen = new Date(bar.time * 1000);
  // Not always open + one timeframe: a daily bar on a session market closes when the exchange
  // does, which is what the alert text and the measured latency should both be based on.
  const barClose = new Date(barCloseMs(bar.time, timeframe, series.meta));
  const verb = direction === "bullish" ? "crossed above" : "crossed below";
  const digits = bar.close >= 100 ? 2 : 4;
  const price = bar.close.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const venue = series.meta?.exchange || symbol.split(":")[0];
  const feedNote = series.delaySeconds > 0
    ? `${venue} via TradingView, ${Math.round(series.delaySeconds / 60)}-min delayed`
    : `${venue} via TradingView`;
  return {
    id: eventId(symbol, timeframe, barOpen, direction),
    source: "watchlist",
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
    title: `${shortSymbol} ${frame}: ${direction} MACD cross`,
    body: `MACD ${verb} signal at ${price} (candle closed ${bangkokClock(barClose)} ICT · ${feedNote})`,
    detected_at: new Date().toISOString(),
    detection_delay_ms: Math.max(0, Date.now() - barClose.getTime()),
    payload: {
      feed: "tradingview_chart_socket",
      venue,
      instrument_type: series.meta?.type ?? null,
      delay_seconds: series.delaySeconds,
      description: series.meta?.description ?? null,
    },
  };
}

async function scanOne(
  client: Client,
  instrument: Instrument,
  state: StateRow | undefined,
  options: { dryRun: boolean; directions: Set<Direction>; budgetEndsAt: number },
): Promise<Record<string, unknown>> {
  const { symbol, timeframe } = instrument;
  const entry: Record<string, unknown> = { symbol, timeframe };
  try {
    let series = await fetchInstrument(symbol, timeframe, MIN_CLOSED_BARS + 40);
    entry.fetches = 1;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const feedNow = Date.now() - series.delaySeconds * 1000;
      if (!shouldRetry(series, timeframe, state, feedNow)) break;
      if (Date.now() + RETRY_DELAY_MS > options.budgetEndsAt) break;
      await sleep(RETRY_DELAY_MS);
      series = await fetchInstrument(symbol, timeframe, MIN_CLOSED_BARS + 40);
      entry.fetches = (entry.fetches as number) + 1;
    }

    entry.delay_seconds = series.delaySeconds;

    // A dated futures contract (TFEX:S50U2026) simply stops producing candles when it expires.
    // Left unsaid, that looks exactly like a working watchlist entry that never signals, so it
    // is reported as the reason rather than allowed to go quiet.
    if (hasExpired(series.meta)) {
      const root = series.meta?.root;
      entry.result = "expired";
      await client.from("watch_state").upsert({
        symbol,
        timeframe,
        last_polled_at: new Date().toISOString(),
        last_error: `Contract expired on ${String(series.meta?.expiration ?? "its last trading day")}` +
          `${root ? `. Watch ${symbol.split(":")[0]}:${root}1! (continuous) or a later month instead` : ""}`,
      }, { onConflict: "symbol,timeframe" });
      return entry;
    }

    const bars = series.bars;
    if (bars.length < MIN_CLOSED_BARS) {
      // Not an error the member can act on, but not a scan either: say so and leave the cursor
      // alone so a later run with fuller history can seed it properly.
      entry.result = `too-few-bars:${bars.length}`;
      await client.from("watch_state").upsert({
        symbol,
        timeframe,
        bars: bars.length,
        last_polled_at: new Date().toISOString(),
        last_error: `TradingView returned ${bars.length} closed bars; ${MIN_CLOSED_BARS} are needed for MACD`,
      }, { onConflict: "symbol,timeframe" });
      return entry;
    }

    const closes = bars.map((bar) => bar.close);
    const points = macdSeries(closes);
    const last = bars.length - 1;
    const bar = bars[last];
    const point = points[last];
    entry.bar_open = new Date(bar.time * 1000).toISOString();
    entry.histogram = point.histogram;

    const known = state?.last_bar_time == null ? null : Number(state.last_bar_time);
    const isNew = known === null || bar.time > known;
    if (!isNew) {
      entry.result = "already-processed";
    } else if (known === null) {
      // First sight of an instrument: adopt its state without firing a notification for a cross
      // that happened before anybody asked to be told about it.
      entry.result = "seeded";
    } else {
      const direction = crossDirection(points[last - 1].histogram, point.histogram);
      entry.result = direction ?? "no-cross";
      const ageMs = Date.now() - series.delaySeconds * 1000 - barCloseMs(bar.time, timeframe, series.meta);
      if (direction && !options.directions.has(direction)) {
        entry.result = `muted:${direction}`;
      } else if (direction && ageMs > maxAgeMs(timeframe)) {
        entry.result = `stale:${Math.round(ageMs / 1000)}s`;
      } else if (direction) {
        const alert = renderAlert(instrument, direction, bar, point, points[last - 1], series);
        entry.alert_id = alert.id;
        if (options.dryRun) {
          entry.dry_run = true;
        } else {
          // The same bar can also be covered by the owner's real-time TradingView webhook, which
          // builds an identical id; whichever producer arrives first is the one that notifies.
          const { error } = await client.from("alerts").upsert(alert, { onConflict: "id", ignoreDuplicates: true });
          if (error) entry.insert_error = error.message;
        }
      }
    }

    if (isNew) {
      // Seed the whole chart window once, then only the bars that are actually new (plus the one
      // before them, in case the provider corrected it). Rewriting 200 rows every scan would be
      // the single largest write on the free tier for no benefit.
      const overlap = known === null ? -1 : bars.findIndex((row) => row.time >= known);
      // No overlap means the stored cursor predates the whole window (a long outage): reseed.
      const from = overlap < 0 ? Math.max(0, bars.length - SEED_CANDLES) : overlap;
      const updatedAt = new Date().toISOString();
      const rows = bars.slice(from).map((row, index) => {
        const macd = points[from + index];
        return {
          symbol,
          timeframe,
          bar_time: new Date(row.time * 1000).toISOString(),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          macd: macd.macd,
          signal: macd.signal,
          histogram: macd.histogram,
          provisional: false,
          updated_at: updatedAt,
        };
      });
      entry.candles_written = rows.length;
      const { error: candleError } = await client
        .from("candles")
        .upsert(rows, { onConflict: "symbol,timeframe,bar_time" });
      if (candleError) entry.candle_error = candleError.message;
    }

    const { error: stateError } = await client.from("watch_state").upsert({
      symbol,
      timeframe,
      last_bar_time: bar.time,
      last_close: bar.close,
      last_hist: point.histogram,
      last_macd: point.macd,
      last_signal: point.signal,
      bars: bars.length,
      last_polled_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: "symbol,timeframe" });
    if (stateError) entry.state_error = stateError.message;
    return entry;
  } catch (error) {
    const message = messageOf(error);
    entry.result = "error";
    entry.error = message;
    await client.from("watch_state").upsert({
      symbol,
      timeframe,
      last_polled_at: new Date().toISOString(),
      last_error: message,
    }, { onConflict: "symbol,timeframe" });
    return entry;
  }
}

/** A small worker pool: the sockets are cheap but not free, and the provider is a shared resource. */
async function mapBounded<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!isSecretCaller(req)) return unauthorized();

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const body: Record<string, unknown> = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const client = adminClient();
  const startedAt = Date.now();
  const budgetEndsAt = startedAt + WAIT_BUDGET_MS;

  const [enabled, dryRun, settleMs, directionList] = await Promise.all([
    getSetting<boolean>(client, "watchlist_enabled", true),
    getSetting<boolean>(client, "watchlist_dry_run", false),
    getSetting<number>(client, "watchlist_settle_ms", 2500),
    getSetting<Direction[]>(client, "alert_directions", ["bullish", "bearish"]),
  ]);
  if (!enabled && !force) return Response.json({ skipped: "watchlist_enabled is false" });

  try {
    const requested = parseInstruments(body.instruments, MAX_INSTRUMENTS);
    const instruments = requested.length ? requested : await allWatchedInstruments(client);
    if (!instruments.length) return Response.json({ ok: true, skipped: "nothing is being watched" });

    // cron fires ON the boundary, so give the provider a moment to finish the candle it has just
    // closed. The catch-up run is already two minutes late and does not wait again.
    if (body.reason !== "catchup" && settleMs > 0) {
      await sleep(Math.min(Math.max(settleMs, 0), 10_000));
    }

    const symbols = [...new Set(instruments.map((instrument) => instrument.symbol))];
    const { data: states, error: stateError } = await client
      .from("watch_state")
      .select("symbol,timeframe,last_bar_time,last_hist")
      .in("symbol", symbols);
    if (stateError) throw new Error(`watch_state query failed: ${stateError.message}`);
    const byInstrument = new Map(
      ((states ?? []) as StateRow[]).map((row) => [`${row.symbol}|${row.timeframe}`, row]),
    );

    const options = { dryRun, directions: new Set(directionList), budgetEndsAt };
    const summary = await mapBounded(instruments, MAX_CONCURRENCY, (instrument) =>
      scanOne(client, instrument, byInstrument.get(`${instrument.symbol}|${instrument.timeframe}`), options));

    const failed = summary.filter((entry) => entry.result === "error").length;
    const alerts = summary.filter((entry) => entry.alert_id).length;
    await heartbeat(client, "watchlist", failed === 0, {
      reason: body.reason ?? "manual",
      instruments: instruments.length,
      alerts,
      failed,
      dry_run: dryRun,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: failed === 0, dry_run: dryRun, alerts, failed, summary });
  } catch (error) {
    const message = messageOf(error);
    await heartbeat(client, "watchlist", false, {
      reason: body.reason ?? "manual",
      error: message,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
});
