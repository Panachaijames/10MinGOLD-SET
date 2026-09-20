import {
  barCloseMs,
  canonicalTicker,
  closedBars,
  expirationMs,
  feedDelaySeconds,
  hasExpired,
  isFinalBar,
  maxAgeMs,
  parseInstruments,
  sessionCloseMinutes,
  sessionCloseMs,
  timeframeSpec,
} from "./instruments.ts";
import type { Bar, SymbolMeta } from "./tradingview.ts";

const denoTest = (Deno as typeof Deno & {
  test(name: string, fn: () => void | Promise<void>): void;
}).test;

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

function bar(time: number, close = 100): Bar {
  return { time, open: close, high: close, low: close, close, volume: null };
}

// The exact strings the live service returns, so a change in shape fails here rather than in
// production. SET's regular session ends 16:30 but the feed's own close allows for the random
// closing auction at 16:40.
const SET_META: SymbolMeta = {
  session: "0955-1230A0900E0955-1231U1355-1640",
  timezone: "Asia/Bangkok",
  exchange: "SET",
  type: "stock",
};
const CRYPTO_META: SymbolMeta = { session: "24x7", timezone: "Etc/UTC", exchange: "Binance" };

denoTest("canonicalTicker accepts real tickers and upper-cases only the exchange", () => {
  assertEquals(canonicalTicker("set:ptt"), "SET:ptt");
  assertEquals(canonicalTicker(" BINANCE:BTCUSDT "), "BINANCE:BTCUSDT");
  assertEquals(canonicalTicker("CME_MINI:ES1!"), "CME_MINI:ES1!");
  assertEquals(canonicalTicker("NASDAQ:BRK.A"), "NASDAQ:BRK.A");
});

denoTest("canonicalTicker rejects anything that is not EXCHANGE:SYMBOL", () => {
  for (const value of ["PTT", "", "a:b", ":PTT", "SET:", "SET:PTT;drop", 15, null]) {
    assertEquals(canonicalTicker(value), null);
  }
});

denoTest("every supported timeframe has a resolution, and M10 alone is resampled", () => {
  assertEquals(timeframeSpec(10)?.sourceMinutes, 5);
  assertEquals(timeframeSpec(15)?.resolution, "15");
  assertEquals(timeframeSpec(1440)?.resolution, "1D");
  assertEquals(timeframeSpec(240)?.sourceMinutes, undefined);
  // Not offered: TradingView refuses it anonymously as a custom resolution.
  assertEquals(timeframeSpec(20), null);
});

denoTest("sessionCloseMinutes takes the latest close across every segment", () => {
  assertEquals(sessionCloseMinutes(SET_META.session), 16 * 60 + 40);
  assertEquals(sessionCloseMinutes("24x7"), null);
  assertEquals(sessionCloseMinutes(undefined), null);
  // Wraps past midnight (CME-style): the close does not belong to the bar's own local date, so
  // the nominal rule has to be used instead of guessing.
  assertEquals(sessionCloseMinutes("1800-1700:23456"), null);
});

denoTest("sessionCloseMs resolves the SET close to 16:40 Bangkok on the bar's own day", () => {
  // 2026-09-17 02:55 UTC is 09:55 Bangkok: the open of that day's SET daily bar.
  const barOpen = Date.UTC(2026, 8, 17, 2, 55) / 1000;
  const expected = Date.UTC(2026, 8, 17, 9, 40); // 16:40 ICT, and Bangkok has no DST
  assertEquals(sessionCloseMs(barOpen, SET_META), expected);
  assertEquals(sessionCloseMs(barOpen, CRYPTO_META), null);
  assertEquals(sessionCloseMs(barOpen, null), null);
});

denoTest("an intraday bar is final once its nominal close has passed", () => {
  const open = Date.UTC(2026, 8, 17, 6, 30) / 1000;
  assertEquals(isFinalBar(bar(open), 15, SET_META, Date.UTC(2026, 8, 17, 6, 44, 59)), false);
  assertEquals(isFinalBar(bar(open), 15, SET_META, Date.UTC(2026, 8, 17, 6, 45)), true);
});

denoTest("a daily bar on a session market is final at the session close, not 24h later", () => {
  const open = Date.UTC(2026, 8, 17, 2, 55) / 1000;
  // Mid-session: still forming.
  assertEquals(isFinalBar(bar(open), 1440, SET_META, Date.UTC(2026, 8, 17, 7, 0)), false);
  // Just after 16:40 Bangkok. The nominal rule would have waited until 02:55 the next morning.
  assertEquals(isFinalBar(bar(open), 1440, SET_META, Date.UTC(2026, 8, 17, 9, 41)), true);
});

denoTest("a daily bar on a 24/7 market is final exactly 24 hours after it opened", () => {
  const open = Date.UTC(2026, 8, 17, 0, 0) / 1000;
  assertEquals(isFinalBar(bar(open), 1440, CRYPTO_META, Date.UTC(2026, 8, 17, 23, 59)), false);
  assertEquals(isFinalBar(bar(open), 1440, CRYPTO_META, Date.UTC(2026, 8, 18, 0, 0)), true);
});

denoTest("barCloseMs reports the exchange close, which is what an alert quotes", () => {
  const setDaily = Date.UTC(2026, 8, 17, 2, 55) / 1000;
  // 16:40 the same day, not 09:55 the next morning.
  assertEquals(barCloseMs(setDaily, 1440, SET_META), Date.UTC(2026, 8, 17, 9, 40));
  const cryptoDaily = Date.UTC(2026, 8, 17, 0, 0) / 1000;
  assertEquals(barCloseMs(cryptoDaily, 1440, CRYPTO_META), Date.UTC(2026, 8, 18, 0, 0));
  // Intraday bars are always nominal, session market or not.
  const intraday = Date.UTC(2026, 8, 17, 6, 30) / 1000;
  assertEquals(barCloseMs(intraday, 15, SET_META), Date.UTC(2026, 8, 17, 6, 45));
  assertEquals(barCloseMs(intraday, 240, SET_META), Date.UTC(2026, 8, 17, 10, 30));
});

denoTest("closedBars drops only the forming bar and keeps every bar behind it", () => {
  const start = Date.UTC(2026, 8, 17, 6, 0) / 1000;
  const bars = [bar(start, 10), bar(start + 900, 11), bar(start + 1800, 12)];
  // 06:45 has not closed yet: two bars survive.
  assertEquals(
    closedBars(bars, 15, CRYPTO_META, Date.UTC(2026, 8, 17, 6, 44)).map((row) => row.close),
    [10, 11],
  );
  // Once it closes, all three are final.
  assertEquals(
    closedBars(bars, 15, CRYPTO_META, Date.UTC(2026, 8, 17, 6, 45)).map((row) => row.close),
    [10, 11, 12],
  );
  assertEquals(closedBars([], 15, CRYPTO_META, Date.now()), []);
});

denoTest("parseInstruments drops junk, de-duplicates, and honours the batch cap", () => {
  const parsed = parseInstruments([
    { symbol: "set:ptt", timeframe: 15 },
    { symbol: "SET:ptt", timeframe: "15" }, // same instrument, timeframe as a string
    { symbol: "PTT", timeframe: 15 }, // no exchange
    { symbol: "SET:PTT", timeframe: 20 }, // unsupported timeframe
    { symbol: "BINANCE:BTCUSDT", timeframe: 1440 },
  ], 10);
  assertEquals(parsed, [
    { symbol: "SET:ptt", timeframe: 15 },
    { symbol: "BINANCE:BTCUSDT", timeframe: 1440 },
  ]);
  assertEquals(parseInstruments(parsed, 1).length, 1);
  assertEquals(parseInstruments("not a list", 10), []);
  assertEquals(parseInstruments(undefined, 10), []);
});

denoTest("maxAgeMs scales with the timeframe but never goes below a quarter of an hour", () => {
  assertEquals(maxAgeMs(5), 15 * 60_000);
  assertEquals(maxAgeMs(15), 30 * 60_000);
  assertEquals(maxAgeMs(1440), 2 * 24 * 60 * 60_000);
});

denoTest("expirationMs reads a futures last trading day and rejects nonsense", () => {
  // TFEX:S50U2026 reports 20260929. The whole of that day is allowed, so a contract is never
  // declared dead while it is still trading.
  assertEquals(expirationMs({ expiration: 20260929 } as SymbolMeta), Date.UTC(2026, 8, 29, 23, 59, 59, 999));
  assertEquals(expirationMs({ expiration: "20260929" } as SymbolMeta), Date.UTC(2026, 8, 29, 23, 59, 59, 999));
  assertEquals(expirationMs(CRYPTO_META), null); // nothing to expire
  assertEquals(expirationMs(null), null);
  assertEquals(expirationMs({ expiration: "2026-09-29" } as SymbolMeta), null);
  assertEquals(expirationMs({ expiration: 20261301 } as SymbolMeta), null); // month 13
  assertEquals(expirationMs({ expiration: 20260231 } as SymbolMeta), null); // 31 February
});

denoTest("hasExpired is false right up to the end of the last trading day", () => {
  const contract = { expiration: 20260929 } as SymbolMeta;
  assertEquals(hasExpired(contract, Date.UTC(2026, 8, 29, 12, 0)), false);
  assertEquals(hasExpired(contract, Date.UTC(2026, 8, 30, 0, 0)), true);
  assertEquals(hasExpired(SET_META, Date.UTC(2030, 0, 1)), false);
});

denoTest("feedDelaySeconds reads the venue's own declared delay", () => {
  assertEquals(feedDelaySeconds({ ...SET_META, delay: 900 } as SymbolMeta), 900);
  assertEquals(feedDelaySeconds(CRYPTO_META), 0);
  assertEquals(feedDelaySeconds(null), 0);
  // A nonsense value must not push the feed clock into the far past.
  assertEquals(feedDelaySeconds({ delay: 999_999 } as SymbolMeta), 3600);
});
