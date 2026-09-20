// Timeframes and closed-bar rules shared by the watchlist scanner and the PWA.
//
// Supported timeframes are M5, M10, M15, M30, H1, H4 and D1. Everything except M10 is a native
// TradingView resolution anonymously; M10 is a paid "custom resolution" and is therefore built
// from complete pairs of M5 bars, exactly as the gold failover already does.
//
// Measured against the live service rather than assumed:
//   1, 3, 5, 15, 30, 45, 60, 120, 240 and 1D all resolve for an unauthenticated session and
//   return 320 bars on request; 10 is refused with `series_error: custom_resolution`.
import { fetchSeries, resample, type Bar, type Series, type SymbolMeta } from "./tradingview.ts";

export const DAILY_MINUTES = 1440;

export interface TimeframeSpec {
  minutes: number;
  /** M15, H4, D1 — what a trader calls it. */
  label: string;
  /** Resolution string the chart socket accepts. */
  resolution: string;
  /** Set when the bars have to be built from a shorter native resolution. */
  sourceMinutes?: number;
}

export const TIMEFRAMES: readonly TimeframeSpec[] = [
  { minutes: 5, label: "M5", resolution: "5" },
  { minutes: 10, label: "M10", resolution: "5", sourceMinutes: 5 },
  { minutes: 15, label: "M15", resolution: "15" },
  { minutes: 30, label: "M30", resolution: "30" },
  { minutes: 60, label: "H1", resolution: "60" },
  { minutes: 240, label: "H4", resolution: "240" },
  { minutes: DAILY_MINUTES, label: "D1", resolution: "1D" },
];

const BY_MINUTES = new Map(TIMEFRAMES.map((spec) => [spec.minutes, spec]));

export function timeframeSpec(minutes: number): TimeframeSpec | null {
  return BY_MINUTES.get(minutes) ?? null;
}

export function timeframeLabel(minutes: number): string {
  return BY_MINUTES.get(minutes)?.label ?? `M${minutes}`;
}

/**
 * TradingView tickers are EXCHANGE:SYMBOL (SET:PTT, BINANCE:BTCUSDT, CME_MINI:ES1!). Returned
 * upper-cased on the exchange half only: some venues have case-sensitive symbols.
 */
export function canonicalTicker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^([A-Za-z0-9_]{2,24}):([A-Za-z0-9._!$+-]{1,32})$/.exec(trimmed);
  if (!match) return null;
  return `${match[1].toUpperCase()}:${match[2]}`;
}

/** Seconds the venue's data is held back from this anonymous session (SET returns 900). */
export function feedDelaySeconds(meta: SymbolMeta | null): number {
  const delay = meta?.delay;
  return typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? Math.min(delay, 3600) : 0;
}

/**
 * When a dated futures contract stops trading, or null for anything that does not expire.
 *
 * The feed gives the last trading day as YYYYMMDD with no time and no zone. Rather than guess
 * the venue's closing minute, the whole of that day is allowed: expiry is only used to explain
 * why an instrument has gone quiet, and being a few hours late to say so is much better than
 * declaring a contract dead while it is still trading.
 */
export function expirationMs(meta: SymbolMeta | null): number | null {
  const raw = meta?.expiration;
  const digits = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{8}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const endOfDay = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  // Date.UTC rolls an impossible date (31 February) into the next month; reject rather than use it.
  const check = new Date(endOfDay);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return endOfDay;
}

/** A contract whose last trading day has passed: it will never publish another candle. */
export function hasExpired(meta: SymbolMeta | null, nowMs = Date.now()): boolean {
  const expires = expirationMs(meta);
  return expires !== null && nowMs > expires;
}

// ------------------------------------------------------------------ session hours

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneParts(utcMs: number, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** How far the zone is ahead of UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zoneParts(utcMs, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

/** The UTC instant of a wall-clock time in a zone. The second pass settles DST transitions. */
function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = asIfUtc - zoneOffsetMs(asIfUtc, timeZone);
  return asIfUtc - zoneOffsetMs(firstPass, timeZone);
}

/**
 * Minutes past local midnight at which the instrument stops trading for the day.
 *
 * TradingView packs the week into one string: "24x7", or segments like
 * "0955-1230A0900E0955-1231U1355-1640" for SET, where the extended-hours markers carry their own
 * HHMM-HHMM pairs. The latest end across every pair is the day's real close (16:40 for SET,
 * covering its random closing auction).
 *
 * Null when the answer cannot be trusted: a 24-hour venue, or a session that wraps past midnight
 * (CME futures open the evening before), where the closing time does not belong to the bar's own
 * local date and the nominal rule is the safer one.
 */
export function sessionCloseMinutes(session: string | undefined): number | null {
  if (!session || session === "24x7") return null;
  let latest: number | null = null;
  for (const match of session.matchAll(/(\d{2})(\d{2})-(\d{2})(\d{2})/g)) {
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (end <= start) return null; // wraps past midnight
    if (latest === null || end > latest) latest = end;
  }
  return latest;
}

/** The instant a daily bar opened on `barOpenSec` stopped moving, or null if it is not knowable. */
export function sessionCloseMs(barOpenSec: number, meta: SymbolMeta | null): number | null {
  const timeZone = meta?.timezone;
  const minutes = sessionCloseMinutes(meta?.session);
  if (!timeZone || minutes === null) return null;
  try {
    const local = zoneParts(barOpenSec * 1000, timeZone);
    const close = zonedTimeToUtcMs(
      local.year,
      local.month,
      local.day,
      Math.floor(minutes / 60),
      minutes % 60,
      timeZone,
    );
    return close > barOpenSec * 1000 ? close : null;
  } catch {
    // An unknown IANA zone: fall back to the nominal rule rather than inventing a close time.
    return null;
  }
}

/**
 * When a bar actually stopped moving.
 *
 * Usually that is its nominal close, one timeframe after it opened. A daily bar on a session
 * market is the exception: a SET daily bar is stamped 09:55 Bangkok, so the nominal rule puts
 * its close at 09:55 the following morning — seventeen hours after the exchange shut. The
 * session string gives the real answer, 16:40 the same day, which is what the alert should
 * report and what the delivery-latency measurement should be taken from.
 */
export function barCloseMs(barOpenSec: number, timeframe: number, meta: SymbolMeta | null): number {
  const nominal = (barOpenSec + timeframe * 60) * 1000;
  if (timeframe < DAILY_MINUTES) return nominal;
  const close = sessionCloseMs(barOpenSec, meta);
  return close !== null && close < nominal ? close : nominal;
}

/**
 * Whether a bar can still change.
 *
 * Every bar except the newest has a successor, and a bar stops updating the moment the next one
 * starts, so only the newest one needs deciding: it is final once its close has passed on the
 * feed's own clock.
 */
export function isFinalBar(bar: Bar, timeframe: number, meta: SymbolMeta | null, feedNowMs: number): boolean {
  return feedNowMs >= barCloseMs(bar.time, timeframe, meta);
}

/** Drop the bar that is still forming. `feedNowMs` must already account for any feed delay. */
export function closedBars(bars: Bar[], timeframe: number, meta: SymbolMeta | null, feedNowMs: number): Bar[] {
  if (!bars.length) return [];
  return isFinalBar(bars[bars.length - 1], timeframe, meta, feedNowMs) ? bars : bars.slice(0, -1);
}

// ------------------------------------------------------------------ scanning

export interface Instrument {
  symbol: string;
  timeframe: number;
}

/**
 * Validate a list of instruments arriving from outside — the cron gate's JSON body, or a manual
 * call. Unusable entries are dropped rather than failing the whole batch, so one bad row in
 * somebody's watchlist cannot stop the scan for everyone else.
 */
export function parseInstruments(value: unknown, limit: number): Instrument[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const parsed: Instrument[] = [];
  for (const entry of value) {
    const record = entry as { symbol?: unknown; timeframe?: unknown };
    const symbol = canonicalTicker(record?.symbol);
    const timeframe = Number(record?.timeframe);
    if (!symbol || !timeframeSpec(timeframe)) continue;
    const key = `${symbol}|${timeframe}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ symbol, timeframe });
    if (parsed.length >= limit) break;
  }
  return parsed;
}

/**
 * How old a crossover may be and still be worth a notification. Anything older is cron catching
 * up after an outage rather than a signal: two bars, and never less than fifteen minutes.
 */
export function maxAgeMs(timeframe: number): number {
  return Math.max(15 * 60_000, timeframe * 60_000 * 2);
}

// ------------------------------------------------------------------ fetching

export interface ClosedSeries {
  bars: Bar[];
  meta: SymbolMeta | null;
  /** Seconds this venue withholds data from an anonymous session. */
  delaySeconds: number;
}

/**
 * `wanted` CLOSED bars for one instrument.
 *
 * The delay is discovered from the response rather than configured per exchange, so a venue that
 * starts or stops withholding data is handled without a code change. It is applied by re-deciding
 * the newest bar against the feed's clock once the metadata is known.
 */
export async function fetchInstrument(
  symbol: string,
  timeframe: number,
  wanted: number,
  nowMs = Date.now(),
): Promise<ClosedSeries> {
  const spec = timeframeSpec(timeframe);
  if (!spec) throw new Error(`Unsupported timeframe: M${timeframe}`);

  let series: Series;
  let bars: Bar[];
  if (spec.sourceMinutes) {
    const slots = timeframe / spec.sourceMinutes;
    series = await fetchSeries(symbol, spec.resolution, wanted * slots + slots * 20);
    bars = resample(series.bars, timeframe, spec.sourceMinutes);
  } else {
    series = await fetchSeries(symbol, spec.resolution, wanted + 20);
    bars = series.bars;
  }

  const delaySeconds = feedDelaySeconds(series.meta);
  return {
    bars: closedBars(bars, timeframe, series.meta, nowMs - delaySeconds * 1000),
    meta: series.meta,
    delaySeconds,
  };
}
