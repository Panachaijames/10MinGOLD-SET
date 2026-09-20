// Turning TradingView search hits into tickers the chart socket will actually resolve.
//
// The shape is not uniform, and the difference matters. A stock is one hit and one ticker. A
// futures root is ONE hit carrying a nested `contracts` array, and the root itself is not a
// symbol at all: `TFEX:S50` is refused with `symbol_error: invalid symbol`, while
// `TFEX:S501!`, `TFEX:S50U2026` and `TFEX:S50Z2026` all resolve and return full history.
// Reading only the top-level `symbol` therefore returned the one result that could never work
// and hid every one that could.
//
// Searching an exact contract code is already handled by the service: asking for "S50Z2026"
// returns the S50 root with `contracts` narrowed to that single contract, so expanding the
// array is all that is needed for the exact-code search to work too.
import { canonicalTicker } from "./instruments.ts";

/** At most this many contracts per root, so one futures search cannot crowd out everything else. */
const MAX_CONTRACTS_PER_ROOT = 10;

export interface SearchContract {
  symbol?: string;
  /** Delivery month for a dated contract: "Sep 2026". */
  description?: string;
  typespecs?: string[];
}

export interface SearchHit {
  symbol?: string;
  description?: string;
  type?: string;
  exchange?: string;
  /** The ticker prefix. `exchange` is a display name ("Binance") and is not usable as one. */
  prefix?: string;
  source_id?: string;
  currency_code?: string;
  country?: string;
  contracts?: SearchContract[];
}

export interface SymbolResult {
  ticker: string;
  symbol: string;
  exchange: string;
  description: string;
  type: string;
  currency: string | null;
  country: string | null;
  /** True for a rolling continuous contract, which never expires. */
  continuous?: boolean;
}

/** Search hits arrive with the matched substring wrapped in <em> when highlighting is on. */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replace(/<\/?em>/g, "").trim() : "";
}

/**
 * How to describe a contract next to its root.
 *
 * A continuous contract ("S501!") rolls to the next delivery month by itself, so it is the one
 * worth watching for a signal that should keep working; a dated contract ("S50U2026") stops
 * producing candles when it expires. Saying which is which is the difference between an
 * informed choice and a watchlist entry that goes quiet without explanation.
 */
export function contractDetail(
  contract: SearchContract,
  rootSymbol = "",
): { detail: string; continuous: boolean } {
  const symbol = plain(contract.symbol);
  const continuous = Array.isArray(contract.typespecs) && contract.typespecs.includes("continuous");
  if (!continuous) return { detail: plain(contract.description), continuous: false };
  // The rank has to be read relative to the root, because the root can itself end in digits:
  // "S501!" is S50 contract 1, not contract 501.
  const suffix = rootSymbol && symbol.startsWith(rootSymbol) ? symbol.slice(rootSymbol.length) : symbol;
  const rank = /^(\d+)!$/.exec(suffix)?.[1] ?? /(\d)!$/.exec(symbol)?.[1];
  return {
    detail: rank === "1" ? "continuous · front month" : `continuous · contract ${rank ?? "?"}`,
    continuous: true,
  };
}

/**
 * Every chartable ticker a single search hit stands for: one for an ordinary instrument, one per
 * contract for a futures root, and none when the hit cannot be turned into a ticker at all.
 */
export function expandHit(hit: SearchHit): SymbolResult[] {
  const prefix = plain(hit.prefix) || plain(hit.source_id);
  const rootSymbol = plain(hit.symbol);
  if (!prefix || !rootSymbol) return [];

  const base = {
    exchange: plain(hit.exchange) || prefix,
    type: plain(hit.type) || "unknown",
    currency: plain(hit.currency_code) || null,
    country: plain(hit.country) || null,
  };
  const rootDescription = plain(hit.description);
  const contracts = Array.isArray(hit.contracts) ? hit.contracts : [];

  if (!contracts.length) {
    const ticker = canonicalTicker(`${prefix}:${rootSymbol}`);
    return ticker ? [{ ...base, ticker, symbol: rootSymbol, description: rootDescription }] : [];
  }

  // The root is dropped deliberately: it is a family of contracts, not a symbol the feed knows.
  const results: SymbolResult[] = [];
  for (const contract of contracts.slice(0, MAX_CONTRACTS_PER_ROOT)) {
    const symbol = plain(contract.symbol);
    const ticker = canonicalTicker(`${prefix}:${symbol}`);
    if (!ticker) continue;
    const { detail, continuous } = contractDetail(contract, rootSymbol);
    results.push({
      ...base,
      ticker,
      symbol,
      description: [rootDescription, detail].filter(Boolean).join(" · "),
      continuous,
    });
  }
  return results;
}

/** Flatten a whole response, keeping the service's own ordering and dropping duplicates. */
export function expandHits(hits: SearchHit[], limit: number): SymbolResult[] {
  const seen = new Set<string>();
  const results: SymbolResult[] = [];
  for (const hit of hits) {
    for (const result of expandHit(hit)) {
      if (seen.has(result.ticker)) continue;
      seen.add(result.ticker);
      results.push(result);
      if (results.length >= limit) return results;
    }
  }
  return results;
}
