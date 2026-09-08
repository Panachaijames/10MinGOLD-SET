// SET stocks: poll TradingView's public scanner for 15-minute MACD values and detect
// crossovers on CLOSED candles. Invoked by pg_cron through ops.set_scan_gate() (weekday,
// holiday, session and kill-switch checks happen there), or manually with ?force=1.
//
// The feed is 15 minutes delayed (update_mode = delayed_streaming_900), so the scanner's
// "current" bar is the one that opened ~15 minutes ago. A bar is treated as final once the
// feed clock (now - 15 min) has passed its close; normally that is the `[1]` bar, but the
// last bar of each session stays at index 0 until the next session opens, so index 0 is
// used whenever the rule says it is complete.
import { isSecretCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { bangkokClock, crossDirection, eventId, type Direction } from "../_shared/macd.ts";

const TIMEFRAME = 15;
const FEED_DELAY_MS = 900 * 1000;
const SCANNER_URL = "https://scanner.tradingview.com/thailand/scan";
const COLUMNS = [
  "name",
  "update_mode|15",
  "time|15",
  "time[1]|15",
  "close|15",
  "close[1]|15",
  "MACD.macd|15",
  "MACD.signal|15",
  "MACD.macd[1]|15",
  "MACD.signal[1]|15",
] as const;

type Row = Record<(typeof COLUMNS)[number], unknown> & { ticker: string };

interface ScannerResponse {
  totalCount: number;
  data: { s: string; d: unknown[] }[];
}

async function fetchScanner(tickers: string[]): Promise<Row[]> {
  const userAgent = Deno.env.get("TV_USER_AGENT") ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  const response = await fetch(SCANNER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      accept: "text/plain, */*; q=0.01",
      "user-agent": userAgent,
      origin: "https://www.tradingview.com",
      referer: "https://www.tradingview.com/",
    },
    body: JSON.stringify({ symbols: { tickers }, columns: COLUMNS, ignore_unknown_fields: false }),
  });
  if (!response.ok) {
    throw new Error(`scanner HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const json = (await response.json()) as ScannerResponse;
  return (json.data ?? []).map((entry) => {
    const row = { ticker: entry.s } as Row;
    COLUMNS.forEach((column, index) => {
      (row as Record<string, unknown>)[column] = entry.d[index];
    });
    return row;
  });
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ClosedBar {
  openEpoch: number;
  close: number | null;
  macd: number;
  signal: number;
  histogram: number;
  /** Histogram of the bar before it when the scanner provides it directly. */
  previousHistogram: number | null;
  fromCurrentBar: boolean;
}

/** Pick the latest candle whose values can no longer change on the delayed feed. */
export function latestClosedBar(row: Row, nowMs: number): ClosedBar | null {
  const t0 = num(row["time|15"]);
  const t1 = num(row["time[1]|15"]);
  const macd0 = num(row["MACD.macd|15"]);
  const signal0 = num(row["MACD.signal|15"]);
  const macd1 = num(row["MACD.macd[1]|15"]);
  const signal1 = num(row["MACD.signal[1]|15"]);
  if (t0 === null || macd0 === null || signal0 === null) return null;
  const feedClockMs = nowMs - FEED_DELAY_MS;
  const currentIsFinal = feedClockMs >= (t0 + TIMEFRAME * 60) * 1000;
  if (currentIsFinal) {
    return {
      openEpoch: t0,
      close: num(row["close|15"]),
      macd: macd0,
      signal: signal0,
      histogram: macd0 - signal0,
      previousHistogram: macd1 !== null && signal1 !== null ? macd1 - signal1 : null,
      fromCurrentBar: true,
    };
  }
  if (t1 === null || macd1 === null || signal1 === null) return null;
  return {
    openEpoch: t1,
    close: num(row["close[1]|15"]),
    macd: macd1,
    signal: signal1,
    histogram: macd1 - signal1,
    previousHistogram: null,
    fromCurrentBar: false,
  };
}

function renderAlert(symbol: string, direction: Direction, bar: ClosedBar) {
  const shortSymbol = symbol.replace(/^SET:/, "");
  const barOpen = new Date(bar.openEpoch * 1000);
  const barClose = new Date((bar.openEpoch + TIMEFRAME * 60) * 1000);
  const verb = direction === "bullish" ? "crossed above" : "crossed below";
  const price = bar.close === null ? "n/a" : bar.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: eventId(symbol, TIMEFRAME, barOpen, direction),
    source: "set_tv",
    symbol,
    timeframe: TIMEFRAME,
    direction,
    bar_time: barOpen.toISOString(),
    bar_close: barClose.toISOString(),
    price: bar.close,
    macd: bar.macd,
    signal: bar.signal,
    histogram: bar.histogram,
    title: `${shortSymbol} M${TIMEFRAME}: ${direction} MACD cross`,
    body: `MACD ${verb} signal at ${price} (candle closed ${bangkokClock(barClose)} ICT · TradingView, 15-min delayed)`,
    detected_at: new Date().toISOString(),
    detection_delay_ms: Math.max(0, Date.now() - barClose.getTime()),
    payload: { feed: "tradingview_scanner", from_current_bar: bar.fromCurrentBar },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!isSecretCaller(req)) return unauthorized();

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const client = adminClient();
  const startedAt = Date.now();
  const enabled = await getSetting<boolean>(client, "set_scan_enabled", false);
  const dryRun = await getSetting<boolean>(client, "set_scan_dry_run", true);
  const tickers = await getSetting<string[]>(client, "set_tickers", []);
  const directions = new Set(await getSetting<Direction[]>(client, "alert_directions", ["bullish", "bearish"]));

  if (!enabled && !force) {
    return Response.json({ skipped: "set_scan_enabled is false" });
  }
  if (!tickers.length) {
    return Response.json({ skipped: "set_tickers is empty" });
  }

  const summary: Record<string, unknown>[] = [];
  let updateMode: string | null = null;
  try {
    const rows = await fetchScanner(tickers);
    if (rows.length !== tickers.length) {
      summary.push({ warning: `scanner returned ${rows.length} rows for ${tickers.length} tickers` });
    }
    const { data: states } = await client
      .from("set_state")
      .select("*")
      .in("symbol", tickers)
      .eq("timeframe", TIMEFRAME);
    const stateBySymbol = new Map((states ?? []).map((s: { symbol: string }) => [s.symbol, s]));

    for (const row of rows) {
      const symbol = row.ticker;
      updateMode = typeof row["update_mode|15"] === "string" ? (row["update_mode|15"] as string) : updateMode;
      const bar = latestClosedBar(row, Date.now());
      const state = stateBySymbol.get(symbol) as
        | { last_bar_time: number | null; last_hist: number | null }
        | undefined;
      const entry: Record<string, unknown> = { symbol, update_mode: row["update_mode|15"] };
      if (!bar) {
        entry.result = "no-data";
        summary.push(entry);
        continue;
      }
      entry.closed_bar_open = new Date(bar.openEpoch * 1000).toISOString();
      entry.histogram = bar.histogram;
      entry.from_current_bar = bar.fromCurrentBar;

      if (state?.last_bar_time != null && bar.openEpoch <= Number(state.last_bar_time)) {
        entry.result = "already-processed";
        summary.push(entry);
        continue;
      }

      const previousHistogram = bar.previousHistogram ?? (state?.last_hist ?? null);
      let direction: Direction | null = null;
      if (state?.last_bar_time == null && bar.previousHistogram === null) {
        entry.result = "seeded";
      } else if (previousHistogram === null) {
        entry.result = "no-previous";
      } else {
        direction = crossDirection(previousHistogram, bar.histogram);
        entry.previous_histogram = previousHistogram;
        entry.result = direction ?? "no-cross";
      }

      if (direction && directions.has(direction)) {
        const alert = renderAlert(symbol, direction, bar);
        entry.alert_id = alert.id;
        if (dryRun) {
          entry.dry_run = true;
        } else {
          const { error } = await client.from("alerts").upsert(alert, { onConflict: "id", ignoreDuplicates: true });
          if (error) entry.insert_error = error.message;
        }
      }

      // One history point per closed bar feeds the PWA's SET MACD chart (the scanner has no OHLC history).
      const { error: historyError } = await client.from("set_macd_history").upsert(
        {
          symbol,
          timeframe: TIMEFRAME,
          bar_time: new Date(bar.openEpoch * 1000).toISOString(),
          close: bar.close,
          macd: bar.macd,
          signal: bar.signal,
          histogram: bar.histogram,
          update_mode: typeof row["update_mode|15"] === "string" ? (row["update_mode|15"] as string) : null,
        },
        { onConflict: "symbol,timeframe,bar_time", ignoreDuplicates: true },
      );
      if (historyError) entry.history_error = historyError.message;

      const { error: stateError } = await client.from("set_state").upsert(
        {
          symbol,
          timeframe: TIMEFRAME,
          last_bar_time: bar.openEpoch,
          last_hist: bar.histogram,
          last_macd: bar.macd,
          last_signal: bar.signal,
          update_mode: row["update_mode|15"] ?? null,
          last_polled_at: new Date().toISOString(),
          last_error: null,
        },
        { onConflict: "symbol,timeframe" },
      );
      if (stateError) entry.state_error = stateError.message;
      summary.push(entry);
    }

    await heartbeat(client, "set_tv", true, {
      update_mode: updateMode,
      tickers: tickers.length,
      dry_run: dryRun,
      duration_ms: Date.now() - startedAt,
      summary,
    });
    return Response.json({ ok: true, dry_run: dryRun, update_mode: updateMode, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await heartbeat(client, "set_tv", false, { error: message, tickers: tickers.length, duration_ms: Date.now() - startedAt });
    await client
      .from("set_state")
      .update({ last_error: message, last_polled_at: new Date().toISOString() })
      .in("symbol", tickers)
      .eq("timeframe", TIMEFRAME);
    return Response.json({ ok: false, error: message, summary }, { status: 502 });
  }
});
