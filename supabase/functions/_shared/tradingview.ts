// Candle history from TradingView's chart socket: the same feed the website draws, reachable
// without an account for anything the exchange does not charge for.
//
// Verified against the live service before this was written:
//   OANDA:XAUUSD      real-time, full OHLC, and its session breaks match the Wisdom broker's
//                     (a 75-minute gap across the 21:00-22:00 UTC break) rather than printing
//                     straight through it the way the Twelve Data feed does.
//   BINANCE:BTCUSDT   real-time (newest bar is the one currently forming).
//   SET:<ticker>      resolves to SET_DLY with a 900-second delay while unauthenticated. That
//                     is the free tier of a paying exchange; the real-time entitlement belongs
//                     to a logged-in session, which is what the alert webhooks already use.
//
// Two constraints were measured, not assumed:
//   * The upgrade request is refused with HTTP 403 unless it carries
//     `Origin: https://www.tradingview.com`. Deno's native WebSocket cannot set headers, so the
//     npm `ws` client is used instead, imported dynamically so a load failure is catchable and
//     can be reported as a feed-health failure.
//   * A 10-minute interval is a paid "custom resolution" and is refused anonymously. Ten-minute
//     candles are therefore built from complete pairs of 5-minute bars.
//
// This is an unofficial protocol. It can change without notice, so connection failures are
// surfaced with enough context for callers to report the feed as unhealthy and retry later.

const ENDPOINT = "wss://data.tradingview.com/socket.io/websocket?type=chart";
const ORIGIN = "https://www.tradingview.com";
const REQUEST_TIMEOUT_MS = 20_000;

export interface Bar {
  /** Bar OPEN time, epoch seconds, UTC. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

const frame = (payload: unknown): string => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `~m~${body.length}~m~${body}`;
};

/** Packets arrive length-prefixed and several to a message; `~h~N` ones are heartbeats. */
const unframe = (raw: string): unknown[] =>
  raw
    .replace(/~h~/g, "")
    .split(/~m~\d+~m~/)
    .filter(Boolean)
    .map((part) => {
      try {
        return JSON.parse(part);
      } catch {
        return part;
      }
    });

const sessionId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 14)}`;

export async function fetchBars(symbol: string, interval: string, count: number): Promise<Bar[]> {
  const { default: WebSocket } = await import("npm:ws@8.18.0");
  return await new Promise<Bar[]>((resolve, reject) => {
    const socket = new WebSocket(ENDPOINT, { origin: ORIGIN });
    const chart = sessionId("cs");
    let settled = false;

    const finish = (error: Error | null, bars?: Bar[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket is being abandoned either way.
      }
      if (error) reject(error);
      else resolve(bars ?? []);
    };

    const timer = setTimeout(
      () => finish(new Error(`TradingView sent no bars for ${symbol} ${interval}m within ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS,
    );

    const send = (method: string, params: unknown[]) => socket.send(frame({ m: method, p: params }));

    socket.on("open", () => {
      send("set_auth_token", ["unauthorized_user_token"]);
      send("chart_create_session", [chart, ""]);
      send("resolve_symbol", [chart, "ser_1", `=${JSON.stringify({ symbol, adjustment: "splits" })}`]);
      send("create_series", [chart, "$prices", "s1", "ser_1", String(interval), count, ""]);
    });

    socket.on("message", (data: unknown) => {
      for (const packet of unframe(String(data))) {
        if (typeof packet === "number" || /^\d+$/.test(String(packet))) {
          socket.send(frame(`~h~${packet}`)); // keep-alive echo, or the server drops us
          continue;
        }
        const message = packet as { m?: string; p?: unknown[] };
        if (!message?.m) continue;
        if (["critical_error", "protocol_error", "symbol_error", "series_error"].includes(message.m)) {
          finish(new Error(`TradingView ${message.m} for ${symbol} ${interval}m: ${JSON.stringify(message.p)}`));
          return;
        }
        if (message.m !== "timescale_update" && message.m !== "du") continue;
        const series = (message.p?.[1] as Record<string, { s?: { v: number[] }[] }> | undefined)?.$prices;
        const rows = series?.s;
        if (!Array.isArray(rows) || !rows.length) continue;
        const bars = rows
          .map((row) => ({
            time: row.v[0],
            open: row.v[1],
            high: row.v[2],
            low: row.v[3],
            close: row.v[4],
            volume: Number.isFinite(row.v[5]) ? row.v[5] : null,
          }))
          .filter((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value)))
          .sort((a, b) => a.time - b.time);
        finish(null, bars);
        return;
      }
    });

    socket.on("error", (error: Error) => finish(error));
    socket.on("close", () => finish(new Error(`TradingView closed the connection for ${symbol} before sending bars`)));
  });
}

/**
 * Combine shorter candles on epoch-aligned boundaries.
 *
 * A bucket is returned only when every expected source slot is present. This matters around
 * OANDA's daily trading break and at the leading edge of a limited history response: treating
 * one M5 candle as a complete M10 candle changes both its close and its MACD crossover.
 */
export function resample(bars: Bar[], minutes: number, sourceMinutes = 5): Bar[] {
  if (
    !Number.isInteger(minutes) ||
    !Number.isInteger(sourceMinutes) ||
    minutes <= 0 ||
    sourceMinutes <= 0 ||
    minutes % sourceMinutes !== 0
  ) {
    throw new RangeError(`Cannot resample ${sourceMinutes}m bars into ${minutes}m bars`);
  }

  const step = minutes * 60;
  const sourceStep = sourceMinutes * 60;
  const expectedSlots = minutes / sourceMinutes;
  const buckets = new Map<number, Bar[]>();
  for (const bar of bars) {
    // A source candle that is not on its own interval boundary cannot fill a known slot.
    if (!Number.isInteger(bar.time) || bar.time % sourceStep !== 0) continue;
    const openTime = Math.floor(bar.time / step) * step;
    const bucket = buckets.get(openTime) ?? [];
    bucket.push(bar);
    buckets.set(openTime, bucket);
  }

  const complete: Bar[] = [];
  for (const [openTime, unsorted] of buckets) {
    const bucket = [...unsorted].sort((a, b) => a.time - b.time);
    const hasEverySlot = bucket.length === expectedSlots &&
      bucket.every((bar, index) => bar.time === openTime + index * sourceStep);
    if (!hasEverySlot) continue;

    complete.push({
      time: openTime,
      open: bucket[0].open,
      high: Math.max(...bucket.map((bar) => bar.high)),
      low: Math.min(...bucket.map((bar) => bar.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.every((bar) => bar.volume !== null)
        ? bucket.reduce((total, bar) => total + (bar.volume ?? 0), 0)
        : null,
    });
  }
  return complete.sort((a, b) => a.time - b.time);
}

/** Only bars whose close has passed can be evaluated; the newest one is still forming. */
export function closedOnly(bars: Bar[], minutes: number, nowMs: number): Bar[] {
  return bars.filter((bar) => (bar.time + minutes * 60) * 1000 <= nowMs);
}

/**
 * Closed candles for one timeframe, building 10-minute bars from 5-minute ones.
 * `count` is the number of CLOSED bars wanted.
 */
export async function fetchClosedBars(
  symbol: string,
  minutes: number,
  count: number,
  nowMs = Date.now(),
): Promise<Bar[]> {
  if (minutes === 10) {
    const fiveMinute = await fetchBars(symbol, "5", count * 2 + 40);
    return closedOnly(resample(fiveMinute, 10, 5), 10, nowMs);
  }
  return closedOnly(await fetchBars(symbol, String(minutes), count + 20), minutes, nowMs);
}
