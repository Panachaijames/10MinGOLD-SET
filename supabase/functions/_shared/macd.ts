// MACD(12,26,9) with the same recursion as pandas ewm(adjust=False) and Pine ta.ema:
// alpha = 2/(n+1), seeded with the first value. Feed >= 260 closed candles so the seed
// has washed out (its residual weight in the 26-EMA is 2e-7 after 200 candles).

export type Direction = "bullish" | "bearish";

export function ema(values: number[], length: number): number[] {
  const alpha = 2 / (length + 1);
  const out: number[] = new Array(values.length);
  let current = values[0];
  for (let i = 0; i < values.length; i++) {
    current = i === 0 ? values[0] : values[i] * alpha + current * (1 - alpha);
    out[i] = current;
  }
  return out;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export function macdSeries(closes: number[], fast = 12, slow = 26, signalLength = 9): MacdPoint[] {
  if (closes.length === 0) return [];
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => fastEma[i] - slowEma[i]);
  const signal = ema(line, signalLength);
  return line.map((macd, i) => ({ macd, signal: signal[i], histogram: macd - signal[i] }));
}

/** Pine ta.crossover / ta.crossunder on the histogram: a touch counts as the side being left. */
export function crossDirection(previousHistogram: number, currentHistogram: number): Direction | null {
  if (!Number.isFinite(previousHistogram) || !Number.isFinite(currentHistogram)) return null;
  if (previousHistogram <= 0 && currentHistogram > 0) return "bullish";
  if (previousHistogram >= 0 && currentHistogram < 0) return "bearish";
  return null;
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok has no DST

export function bangkokClock(date: Date): string {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/** Event id in the same shape as the laptop watcher: SYMBOL:15m:20260908T031500Z:bullish */
export function eventId(symbol: string, timeframe: number, barOpen: Date, direction: Direction): string {
  const stamp = barOpen.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${symbol}:${timeframe}m:${stamp}:${direction}`;
}
