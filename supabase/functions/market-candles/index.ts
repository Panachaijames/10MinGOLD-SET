// Backfill and refresh chart candles from TradingView's chart socket.
//
// SET history is available as delayed M15 OHLC, while Binance BTC is available in real time
// at M10 (resampled from M5 by the shared helper) and M15. Cron calls the two markets
// separately so the SET session/holiday gate does not stop Bitcoin's 24/7 refresh.
import { isSecretCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { macdSeries } from "../_shared/macd.ts";
import { fetchClosedBars, type Bar } from "../_shared/tradingview.ts";

const MIN_CLOSED_BARS = 260;
const CANDLE_HISTORY = 200;
const MAX_CONCURRENCY = 3;
const SET_FEED_DELAY_MS = 15 * 60 * 1000;
const BITCOIN_SYMBOL = "BINANCE:BTCUSDT";
const BITCOIN_TIMEFRAMES = [10, 15] as const;

type Market = "set" | "bitcoin";
type Scope = Market | "all";
type Client = ReturnType<typeof adminClient>;

interface Instrument {
  market: Market;
  symbol: string;
  timeframe: number;
}

interface InstrumentResult {
  market: Market;
  symbol: string;
  timeframe: number;
  ok: boolean;
  result: string;
  fetched?: number;
  stored?: number;
  newest_bar?: string;
  error?: string;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function parseScope(value: unknown): Scope {
  if (value === undefined || value === null || value === "") return "all";
  if (value === "set" || value === "bitcoin" || value === "all") return value;
  throw new Error("market must be one of: set, bitcoin, all");
}

function parseTimeframes(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [...BITCOIN_TIMEFRAMES];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const frames = [...new Set(raw.map(Number))];
  if (!frames.length || frames.some((frame) => !BITCOIN_TIMEFRAMES.includes(frame as 10 | 15))) {
    throw new Error("timeframes must contain only 10 and/or 15");
  }
  return frames.sort((a, b) => a - b);
}

function chartHistoryLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return CANDLE_HISTORY;
  return Math.min(parsed, CANDLE_HISTORY);
}

/** Keep only valid, unique OHLC rows before calculating indicators or writing to Postgres. */
function normalizeBars(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) {
    if (!Number.isInteger(bar.time) || bar.time <= 0) continue;
    if (![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) continue;
    byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function ingest(client: Client, instrument: Instrument, historyLimit: number): Promise<InstrumentResult> {
  const base = {
    market: instrument.market,
    symbol: instrument.symbol,
    timeframe: instrument.timeframe,
  };
  try {
    const { data: latestRows, error: latestError } = await client
      .from("candles")
      .select("bar_time")
      .eq("symbol", instrument.symbol)
      .eq("timeframe", instrument.timeframe)
      .order("bar_time", { ascending: false })
      .limit(1);
    if (latestError) throw new Error(`latest-candle query failed: ${latestError.message}`);
    const latestStored = Array.isArray(latestRows) && latestRows.length
      ? Date.parse(String(latestRows[0].bar_time))
      : null;
    if (latestStored !== null && !Number.isFinite(latestStored)) {
      throw new Error("latest-candle query returned an invalid bar_time");
    }

    // The shared helper asks for extra source rows so that at least 260 CLOSED bars remain after
    // the live/forming bar is removed. That long warm-up makes the EMA seed negligible.
    const feedNow = Date.now() - (instrument.market === "set" ? SET_FEED_DELAY_MS : 0);
    const bars = normalizeBars(
      await fetchClosedBars(instrument.symbol, instrument.timeframe, MIN_CLOSED_BARS, feedNow),
    );
    if (bars.length < MIN_CLOSED_BARS) {
      throw new Error(`TradingView returned ${bars.length} valid closed bars; ${MIN_CLOSED_BARS} are required`);
    }

    const series = macdSeries(bars.map((bar) => bar.close));
    // Seed a new instrument with the full chart window. On normal refreshes, rewrite the candle
    // before the latest stored one (in case the provider corrected it), then add every catch-up
    // candle through the newest close. The chart-window floor caps an unusually large backlog.
    let from = Math.max(0, bars.length - historyLimit);
    if (latestStored !== null) {
      const correctionFrom = latestStored / 1000 - instrument.timeframe * 60;
      while (from < bars.length && bars[from].time < correctionFrom) from++;
    }
    const updatedAt = new Date().toISOString();
    const rows = bars.slice(from).map((bar, index) => {
      const point = series[from + index];
      return {
        symbol: instrument.symbol,
        timeframe: instrument.timeframe,
        bar_time: new Date(bar.time * 1000).toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        macd: point.macd,
        signal: point.signal,
        histogram: point.histogram,
        provisional: false,
        updated_at: updatedAt,
      };
    });

    if (!rows.length) {
      return {
        ...base,
        ok: true,
        result: "no-source-overlap",
        fetched: bars.length,
        stored: 0,
        newest_bar: new Date(bars[bars.length - 1].time * 1000).toISOString(),
      };
    }

    const { error } = await client.from("candles").upsert(rows, {
      onConflict: "symbol,timeframe,bar_time",
    });
    if (error) throw new Error(`candle upsert failed: ${error.message}`);

    return {
      ...base,
      ok: true,
      result: latestStored === null ? "seeded" : "updated",
      fetched: bars.length,
      stored: rows.length,
      newest_bar: rows[rows.length - 1].bar_time,
    };
  } catch (error) {
    return { ...base, ok: false, result: "error", error: messageOf(error) };
  }
}

/** A small worker pool avoids opening all eleven TradingView sockets at once. */
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

  const startedAt = Date.now();
  const url = new URL(req.url);
  const rawBody: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? rawBody as Record<string, unknown>
    : {};

  let scope: Scope;
  let requestedBitcoinFrames: number[];
  try {
    scope = parseScope(url.searchParams.get("market") ?? body.market);
    requestedBitcoinFrames = parseTimeframes(url.searchParams.get("timeframes") ?? body.timeframes);
  } catch (error) {
    return Response.json({ ok: false, error: messageOf(error) }, { status: 400 });
  }

  const client = adminClient();
  const force = url.searchParams.get("force") === "1";
  const [
    enabled,
    bitcoinEnabled,
    configuredTickersValue,
    configuredBitcoinSymbol,
    configuredBitcoinFramesValue,
    configuredHistoryLimit,
  ] = await Promise.all([
    getSetting<boolean>(client, "market_candles_enabled", true),
    getSetting<boolean>(client, "bitcoin_chart_enabled", true),
    getSetting<unknown>(client, "set_tickers", []),
    getSetting<unknown>(client, "bitcoin_symbol", BITCOIN_SYMBOL),
    getSetting<unknown>(client, "bitcoin_timeframes", [...BITCOIN_TIMEFRAMES]),
    getSetting<unknown>(client, "chart_candle_limit", CANDLE_HISTORY),
  ]);
  const historyLimit = chartHistoryLimit(configuredHistoryLimit);

  if (!enabled && !force) return Response.json({ ok: true, skipped: "market_candles_enabled is false" });
  if (scope === "bitcoin" && !bitcoinEnabled && !force) {
    return Response.json({ ok: true, skipped: "bitcoin_chart_enabled is false" });
  }

  const summary: InstrumentResult[] = [];
  const instruments: Instrument[] = [];
  if (scope === "set" || scope === "all") {
    const configuredTickers = Array.isArray(configuredTickersValue) ? configuredTickersValue : [];
    if (!Array.isArray(configuredTickersValue)) {
      summary.push({
        market: "set",
        symbol: "set_tickers",
        timeframe: 15,
        ok: false,
        result: "invalid-setting",
        error: "set_tickers must be a JSON array",
      });
    }
    const seen = new Set<string>();
    for (const ticker of configuredTickers) {
      if (typeof ticker !== "string" || !/^SET:[A-Z0-9._-]+$/.test(ticker)) {
        summary.push({
          market: "set",
          symbol: typeof ticker === "string" ? ticker : String(ticker),
          timeframe: 15,
          ok: false,
          result: "invalid-setting",
          error: "set_tickers entries must be canonical SET:* symbols",
        });
      } else if (!seen.has(ticker)) {
        seen.add(ticker);
        instruments.push({ market: "set", symbol: ticker, timeframe: 15 });
      }
    }
  }
  if ((scope === "bitcoin" || scope === "all") && (bitcoinEnabled || force)) {
    let configuredFrames: number[] = [];
    try {
      configuredFrames = parseTimeframes(configuredBitcoinFramesValue);
    } catch (error) {
      summary.push({
        market: "bitcoin",
        symbol: String(configuredBitcoinSymbol),
        timeframe: 0,
        ok: false,
        result: "invalid-setting",
        error: `bitcoin_timeframes: ${messageOf(error)}`,
      });
    }
    if (configuredBitcoinSymbol !== BITCOIN_SYMBOL) {
      summary.push({
        market: "bitcoin",
        symbol: String(configuredBitcoinSymbol),
        timeframe: 0,
        ok: false,
        result: "invalid-setting",
        error: `bitcoin_symbol must be ${BITCOIN_SYMBOL}`,
      });
    } else {
      for (const timeframe of requestedBitcoinFrames.filter((frame) => configuredFrames.includes(frame))) {
        instruments.push({ market: "bitcoin", symbol: configuredBitcoinSymbol, timeframe });
      }
    }
  }

  if (!instruments.length) {
    const reason = scope === "set" ? "set_tickers is empty" : "no instruments enabled";
    await heartbeat(client, "market_candles", false, {
      scope,
      error: reason,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: false, error: reason, summary }, { status: 503 });
  }

  try {
    summary.push(...await mapBounded(
      instruments,
      MAX_CONCURRENCY,
      (instrument) => ingest(client, instrument, historyLimit),
    ));
    const succeeded = summary.filter((entry) => entry.ok).length;
    const failed = summary.length - succeeded;
    await heartbeat(client, "market_candles", failed === 0, {
      scope,
      requested: summary.length,
      succeeded,
      failed,
      history_limit: historyLimit,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    const payload = { ok: failed === 0, partial: succeeded > 0 && failed > 0, succeeded, failed, summary };
    return Response.json(payload, { status: succeeded > 0 ? 200 : 502 });
  } catch (error) {
    const message = messageOf(error);
    await heartbeat(client, "market_candles", false, {
      scope,
      error: message,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: false, error: message, summary }, { status: 502 });
  }
});
