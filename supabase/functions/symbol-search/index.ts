// Instrument search for the PWA's "add to watchlist" box.
//
// The browser cannot call TradingView's search endpoint directly (no CORS headers, and the
// request needs a tradingview.com Origin), so this function is the proxy. It normalises what
// comes back into the EXCHANGE:SYMBOL form the watchlist and the chart socket both use, which
// is `prefix` or `source_id` — never the `exchange` field, a display name ("Binance") that is
// not a valid ticker prefix.
//
// Membership is required. Search is a call out to a third party on the project's IP, so a
// signed-in-but-not-admitted account must not be able to drive it.
import { callerMember, unauthorized } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/db.ts";
import { canonicalTicker } from "../_shared/instruments.ts";

const SEARCH_URL = "https://symbol-search.tradingview.com/symbol_search/v3/";
const MAX_RESULTS = 30;
const REQUEST_TIMEOUT_MS = 10_000;

interface SearchHit {
  symbol?: string;
  description?: string;
  type?: string;
  exchange?: string;
  prefix?: string;
  source_id?: string;
  currency_code?: string;
  country?: string;
}

interface Result {
  ticker: string;
  symbol: string;
  exchange: string;
  description: string;
  type: string;
  currency: string | null;
  country: string | null;
}

/** Search hits arrive with the matched substring wrapped in <em> for highlighting. */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replace(/<\/?em>/g, "").trim() : "";
}

export function toResult(hit: SearchHit): Result | null {
  const symbol = plain(hit.symbol);
  const prefix = plain(hit.prefix) || plain(hit.source_id);
  if (!symbol || !prefix) return null;
  const ticker = canonicalTicker(`${prefix}:${symbol}`);
  if (!ticker) return null;
  return {
    ticker,
    symbol,
    exchange: plain(hit.exchange) || prefix,
    description: plain(hit.description),
    type: plain(hit.type) || "unknown",
    currency: plain(hit.currency_code) || null,
    country: plain(hit.country) || null,
  };
}

Deno.serve(async (req) => {
  const headers = corsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers });
  }
  if (!(await callerMember(req))) return unauthorized("membership required");

  const url = new URL(req.url);
  const body: Record<string, unknown> = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const text = String(url.searchParams.get("text") ?? body.text ?? "").trim().slice(0, 40);
  const exchange = String(url.searchParams.get("exchange") ?? body.exchange ?? "").trim().slice(0, 24);
  if (text.length < 1) return Response.json({ results: [] }, { headers });

  const query = new URLSearchParams({
    text,
    hl: "0",
    lang: "en",
    domain: "production",
    // TradingView returns futures contracts as nested arrays that cannot be charted by ticker
    // alone; asking for the plain list keeps every result directly usable.
    search_type: "undefined",
  });
  if (exchange) query.set("exchange", exchange);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${SEARCH_URL}?${query}`, {
      headers: {
        accept: "application/json",
        origin: "https://www.tradingview.com",
        referer: "https://www.tradingview.com/",
        "user-agent": Deno.env.get("TV_USER_AGENT") ??
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return Response.json(
        { error: `TradingView search returned HTTP ${response.status}`, results: [] },
        { status: 502, headers },
      );
    }
    const payload = (await response.json()) as { symbols?: SearchHit[] };
    const seen = new Set<string>();
    const results: Result[] = [];
    for (const hit of payload.symbols ?? []) {
      const result = toResult(hit);
      if (!result || seen.has(result.ticker)) continue;
      seen.add(result.ticker);
      results.push(result);
      if (results.length >= MAX_RESULTS) break;
    }
    return Response.json({ results }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = message.includes("abort");
    return Response.json(
      { error: timedOut ? "TradingView search timed out" : message, results: [] },
      { status: 502, headers },
    );
  } finally {
    clearTimeout(timer);
  }
});
