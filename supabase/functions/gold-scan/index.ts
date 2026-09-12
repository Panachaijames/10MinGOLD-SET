// Gold failover scanner: MACD crossovers on CLOSED 10m and 15m candles from the Twelve Data
// cloud feed, so alerts keep arriving while the laptop (and its MT5 terminal) is off.
//
// It is a stand-in, not a replacement. The broker feed and a spot feed disagree on candle
// micro-structure, and Twelve Data prints bars through the broker's 21:00-22:00 UTC break,
// so this source fires somewhat more crosses than MT5 does on the same window. Invoked by
// pg_cron through ops.gold_scan_gate(), which only posts here when the laptop heartbeat has
// gone quiet, so the two producers never race for the same bar. Manual run: ?force=1.
import { isSecretCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { bangkokClock, crossDirection, eventId, macdSeries, type Direction } from "../_shared/macd.ts";

const BASE_URL = "https://api.twelvedata.com/time_series";
const FEED_SYMBOL = "XAU/USD";
// MACD(12,26,9) needs a long warm-up before the EMA seed washes out; the laptop uses 260 too.
const MIN_CLOSED_BARS = 260;
const CANDLE_HISTORY = 200;

interface Bar {
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchSeries(interval: string, outputsize: number): Promise<Bar[]> {
  const apiKey = Deno.env.get("TWELVEDATA_API_KEY");
  if (!apiKey) throw new Error("TWELVEDATA_API_KEY is not set on the function");
  const params = new URLSearchParams({
    symbol: FEED_SYMBOL,
    interval,
    outputsize: String(outputsize),
    timezone: "UTC",
    apikey: apiKey,
  });
  const response = await fetch(`${BASE_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const json = await response.json();
  if (json?.status === "error") throw new Error(`Twelve Data ${json.code}: ${json.message}`);
  const values = json?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Twelve Data returned no ${interval} values for ${FEED_SYMBOL}`);
  }
  const bars: Bar[] = [];
  for (const value of values) {
    const close = num(value.close);
    const openMs = Date.parse(`${String(value.datetime).replace(" ", "T")}Z`);
    if (close === null || !Number.isFinite(openMs)) continue;
    bars.push({
      openMs,
      open: num(value.open) ?? close,
      high: num(value.high) ?? close,
      low: num(value.low) ?? close,
      close,
    });
  }
  return bars.sort((a, b) => a.openMs - b.openMs);
}

/** Twelve Data has no 10-minute interval: pair its 5-minute bars on epoch boundaries. */
export function toTenMinutes(fiveMinute: Bar[]): Bar[] {
  const buckets = new Map<number, Bar>();
  for (const bar of fiveMinute) {
    const openMs = Math.floor(bar.openMs / 600_000) * 600_000;
    const existing = buckets.get(openMs);
    if (!existing) {
      buckets.set(openMs, { ...bar, openMs });
      continue;
    }
    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
  }
  return [...buckets.values()].sort((a, b) => a.openMs - b.openMs);
}

/** Drop the bar that is still forming: only a bar whose close has passed can be evaluated. */
export function closedOnly(bars: Bar[], timeframe: number, nowMs: number): Bar[] {
  return bars.filter((bar) => bar.openMs + timeframe * 60_000 <= nowMs);
}

async function loadClosedBars(timeframe: number, nowMs: number): Promise<Bar[]> {
  if (timeframe === 15) {
    return closedOnly(await fetchSeries("15min", MIN_CLOSED_BARS + 60), 15, nowMs);
  }
  if (timeframe === 10) {
    return closedOnly(toTenMinutes(await fetchSeries("5min", MIN_CLOSED_BARS * 2 + 100)), 10, nowMs);
  }
  throw new Error(`Unsupported gold timeframe: ${timeframe}`);
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
    body: `MACD ${verb} signal at ${price} (candle closed ${bangkokClock(barClose)} ICT · cloud feed, laptop offline)`,
    detected_at: new Date().toISOString(),
    detection_delay_ms: Math.max(0, Date.now() - barClose.getTime()),
    payload: { feed: "twelvedata", feed_symbol: FEED_SYMBOL, failover: true },
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
  const directions = new Set(await getSetting<Direction[]>(client, "alert_directions", ["bullish", "bearish"]));
  const requested: number[] = Array.isArray(body?.timeframes) && body.timeframes.length
    ? body.timeframes.map(Number)
    : [10, 15];

  const summary: Record<string, unknown>[] = [];
  try {
    for (const timeframe of requested) {
      const entry: Record<string, unknown> = { timeframe };
      const bars = await loadClosedBars(timeframe, Date.now());
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
      feed: FEED_SYMBOL,
      dry_run: dryRun,
      timeframes: requested,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: true, dry_run: dryRun, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await heartbeat(client, "gold_cloud", false, { error: message, timeframes: requested, duration_ms: Date.now() - startedAt });
    return Response.json({ ok: false, error: message, summary }, { status: 502 });
  }
});
