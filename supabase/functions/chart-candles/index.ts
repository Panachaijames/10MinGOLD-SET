// Candles for a chart the PWA is asking to draw right now.
//
// The scheduled scanners only store the timeframes somebody is being alerted on. Looking at a
// chart is a different thing from being alerted — that separation is the whole point of the
// watchlist — so a pane must be able to show any supported timeframe of an instrument the
// deployment knows, whether or not anyone has it on their alert list.
//
// This is the on-demand half of that: given a symbol and a timeframe with nothing stored, fetch
// the closed candles, compute MACD over them, and write them to the same `candles` table every
// other producer writes to. It raises no alerts and keeps no cursor; it only fills the chart.
import { callerMember, unauthorized } from "../_shared/auth.ts";
import { adminClient, corsHeaders, getSetting } from "../_shared/db.ts";
import { macdSeries } from "../_shared/macd.ts";
import { canonicalTicker, fetchInstrument, timeframeSpec } from "../_shared/instruments.ts";

const MIN_CLOSED_BARS = 260;
const CANDLE_HISTORY = 200;
// The broker's own gold symbol is not a TradingView ticker, so charts of it away from the
// watcher's own timeframes are drawn from the same OANDA series the cloud failover uses.
const GOLD_FEED_SYMBOL = "OANDA:XAUUSD";
// One fetch per instrument and timeframe in this window, however many panes ask for it. It caps
// what opening a chart can cost, and closed markets have nothing new to give anyway.
const REFETCH_AFTER_MS = 15 * 60_000;

type Client = ReturnType<typeof adminClient>;

/**
 * Only instruments this deployment already knows about.
 *
 * Without it the function would fetch any ticker on request, spending the project's rate limit
 * and its IP reputation on whatever a caller typed.
 */
async function isKnownSymbol(client: Client, symbol: string): Promise<boolean> {
  const [goldSymbol, bitcoinSymbol, setTickers] = await Promise.all([
    getSetting<string>(client, "gold_symbol", "GOLD.wis"),
    getSetting<string>(client, "bitcoin_symbol", "BINANCE:BTCUSDT"),
    getSetting<unknown>(client, "set_tickers", []),
  ]);
  if (symbol === goldSymbol || symbol === bitcoinSymbol) return true;
  if (Array.isArray(setTickers) && setTickers.includes(symbol)) return true;
  const { data } = await client.from("watchlist").select("symbol").eq("symbol", symbol).limit(1);
  return Boolean(data?.length);
}

Deno.serve(async (req) => {
  const headers = corsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers });
  if (!(await callerMember(req))) return unauthorized("membership required");

  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  // Gold is stored under the broker's own name ("GOLD.wis"), which is not a TradingView ticker
  // and so does not survive canonicalTicker; it is still bounded and still checked below.
  const symbol = canonicalTicker(body.symbol) ?? String(body.symbol ?? "").trim().slice(0, 64);
  const timeframe = Number(body.timeframe);
  if (!symbol || !timeframeSpec(timeframe)) {
    return Response.json({ ok: false, error: "symbol and a supported timeframe are required" }, { status: 400, headers });
  }

  const client = adminClient();
  try {
    if (!(await isKnownSymbol(client, symbol))) {
      return Response.json({ ok: false, error: "that instrument is not on this deployment" }, { status: 404, headers });
    }

    const { data: latest } = await client
      .from("candles")
      .select("bar_time,updated_at")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .order("bar_time", { ascending: false })
      .limit(1);
    const lastWrite = latest?.length ? Date.parse(String(latest[0].updated_at)) : NaN;
    if (Number.isFinite(lastWrite) && Date.now() - lastWrite < REFETCH_AFTER_MS) {
      return Response.json({ ok: true, result: "already-fresh", newest: latest?.[0]?.bar_time ?? null }, { headers });
    }

    const goldSymbol = await getSetting<string>(client, "gold_symbol", "GOLD.wis");
    const feedSymbol = symbol === goldSymbol ? GOLD_FEED_SYMBOL : symbol;
    const series = await fetchInstrument(feedSymbol, timeframe, MIN_CLOSED_BARS + 40);
    if (series.bars.length < MIN_CLOSED_BARS) {
      return Response.json(
        { ok: false, error: `only ${series.bars.length} closed bars are available; ${MIN_CLOSED_BARS} are needed for MACD` },
        { status: 502, headers },
      );
    }

    const points = macdSeries(series.bars.map((bar) => bar.close));
    const from = Math.max(0, series.bars.length - CANDLE_HISTORY);
    const updatedAt = new Date().toISOString();
    const rows = series.bars.slice(from).map((bar, index) => {
      const point = points[from + index];
      return {
        // Stored under the deployment's own name for the instrument, not the feed's, so the
        // broker's gold candles and these share one series.
        symbol,
        timeframe,
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
    // ignoreDuplicates keeps a producer that owns this series authoritative: the laptop's own
    // broker candles are never overwritten by the stand-in feed.
    const ignoreDuplicates = symbol === goldSymbol;
    const { error } = await client
      .from("candles")
      .upsert(rows, { onConflict: "symbol,timeframe,bar_time", ignoreDuplicates });
    if (error) throw new Error(`candle upsert failed: ${error.message}`);

    return Response.json({
      ok: true,
      result: "stored",
      stored: rows.length,
      newest: rows[rows.length - 1].bar_time,
      delay_seconds: series.delaySeconds,
      feed_symbol: feedSymbol === symbol ? undefined : feedSymbol,
    }, { headers });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    return Response.json({ ok: false, error: message }, { status: 502, headers });
  }
});
