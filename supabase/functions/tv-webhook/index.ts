// TradingView alert receiver: real-time SET crossovers pushed to us instead of polled.
//
// The public scanner endpoint that set-scan polls is anonymous, so it serves 15-minute delayed
// data no matter what the account pays for. A TradingView alert fires from the subscriber's own
// session the moment the candle closes, so routing alerts through a webhook is what actually
// buys the real-time SET data add-on.
//
// The alert row it writes is identical in shape and id to the one set-scan would have written
// for the same bar, so the two can run side by side: whichever arrives first wins and the other
// is ignored as a duplicate. Delivery (push, LINE, history, chart) is unchanged.
//
// TradingView cannot send custom headers, so the caller proves itself with a shared secret in
// the JSON body (preferred) or a ?token= query parameter.
import { adminClient, getSetting, heartbeat } from "../_shared/db.ts";
import { bangkokClock, eventId, type Direction } from "../_shared/macd.ts";

const SUPPORTED_TIMEFRAMES = new Set([10, 15]);
const MAX_BODY_BYTES = 8_192;
// A bar that closed in the future means a clock problem; a little skew is normal.
const FUTURE_SKEW_MS = 120_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** TradingView reports the chart interval as a bare minute count: "10", "15". */
export function parseTimeframe(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return SUPPORTED_TIMEFRAMES.has(minutes) ? minutes : null;
}

export function parseDirection(value: unknown): Direction | null {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "bullish" || text === "bearish" ? text : null;
}

/** Bar open in epoch ms, from Pine's `time` (already UTC) or an ISO string. */
export function parseBarOpenMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function render(symbol: string, timeframe: number, direction: Direction, barOpenMs: number, values: {
  price: number | null;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}) {
  const barOpen = new Date(barOpenMs);
  const barClose = new Date(barOpenMs + timeframe * 60_000);
  const shortSymbol = symbol.replace(/^SET:/, "");
  const verb = direction === "bullish" ? "crossed above" : "crossed below";
  const price = values.price === null
    ? "n/a"
    : values.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: eventId(symbol, timeframe, barOpen, direction),
    source: "set_tv",
    symbol,
    timeframe,
    direction,
    bar_time: barOpen.toISOString(),
    bar_close: barClose.toISOString(),
    price: values.price,
    macd: values.macd,
    signal: values.signal,
    histogram: values.histogram,
    title: `${shortSymbol} M${timeframe}: ${direction} MACD cross`,
    body: `MACD ${verb} signal at ${price} (candle closed ${bangkokClock(barClose)} ICT · TradingView real-time)`,
    detected_at: new Date().toISOString(),
    detection_delay_ms: Math.max(0, Date.now() - barClose.getTime()),
    payload: { feed: "tradingview_webhook", via: "webhook" },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("TV_WEBHOOK_SECRET") ?? "";
  if (!secret) {
    console.error("TV_WEBHOOK_SECRET is not set on the function");
    return Response.json({ error: "receiver not configured" }, { status: 503 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "body too large" }, { status: 413 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A plain-text alert message means the Pine script or the alert body is misconfigured.
    console.error("TradingView payload was not JSON:", raw.slice(0, 200));
    return Response.json({ error: "expected a JSON alert message" }, { status: 400 });
  }

  const offered = String(body.secret ?? new URL(req.url).searchParams.get("token") ?? "");
  if (!timingSafeEqual(offered, secret)) {
    console.error("Rejected a TradingView webhook with a bad secret");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const client = adminClient();
  if (!(await getSetting<boolean>(client, "tv_webhook_enabled", true))) {
    return Response.json({ skipped: "tv_webhook_enabled is false" });
  }

  const symbol = String(body.symbol ?? "").trim();
  const timeframe = parseTimeframe(body.timeframe);
  const direction = parseDirection(body.direction);
  const barOpenMs = parseBarOpenMs(body.bar_time_ms ?? body.bar_time);
  if (!symbol || symbol.length > 64) return Response.json({ error: "bad symbol" }, { status: 400 });
  if (timeframe === null) return Response.json({ error: `unsupported timeframe: ${body.timeframe}` }, { status: 400 });
  if (direction === null) return Response.json({ error: `unsupported direction: ${body.direction}` }, { status: 400 });
  if (barOpenMs === null) return Response.json({ error: "bad bar_time" }, { status: 400 });

  const barCloseMs = barOpenMs + timeframe * 60_000;
  const ageMs = Date.now() - barCloseMs;
  const maxAgeSeconds = await getSetting<number>(client, "tv_webhook_max_age_seconds", 1800);
  if (ageMs > maxAgeSeconds * 1000) {
    // A replayed or long-delayed alert must not wake the phone as if it were fresh.
    return Response.json({ skipped: `stale by ${Math.round(ageMs / 1000)}s`, bar_time: new Date(barOpenMs).toISOString() });
  }
  if (ageMs < -FUTURE_SKEW_MS) {
    return Response.json({ error: "bar closes in the future; check the alert message" }, { status: 400 });
  }

  const directions = new Set(await getSetting<Direction[]>(client, "alert_directions", ["bullish", "bearish"]));
  if (!directions.has(direction)) return Response.json({ skipped: `muted:${direction}` });

  const values = {
    price: num(body.price),
    macd: num(body.macd),
    signal: num(body.signal),
    histogram: num(body.histogram),
  };
  const alert = render(symbol, timeframe, direction, barOpenMs, values);

  // ignoreDuplicates: TradingView may re-fire, and set-scan may reach the same bar later on
  // delayed data. Both produce this id, so the first one through is the only notification.
  const { error } = await client.from("alerts").upsert(alert, { onConflict: "id", ignoreDuplicates: true });
  if (error) {
    console.error("Alert insert failed:", error.message);
    await heartbeat(client, "set_tv_webhook", false, { error: error.message, symbol, timeframe });
    return Response.json({ error: error.message }, { status: 500 });
  }

  // One chart point for the cross bar, so the PWA's SET chart shows it without waiting for the
  // delayed scanner pass. ignoreDuplicates keeps the scanner's own history authoritative.
  if (values.macd !== null && values.signal !== null) {
    await client.from("set_macd_history").upsert(
      {
        symbol,
        timeframe,
        bar_time: alert.bar_time,
        close: values.price,
        macd: values.macd,
        signal: values.signal,
        histogram: values.histogram,
        update_mode: "realtime_webhook",
      },
      { onConflict: "symbol,timeframe,bar_time", ignoreDuplicates: true },
    );
  }

  await heartbeat(client, "set_tv_webhook", true, {
    symbol,
    timeframe,
    direction,
    bar_time: alert.bar_time,
    detection_delay_ms: alert.detection_delay_ms,
  });

  return Response.json({ ok: true, id: alert.id, detection_delay_ms: alert.detection_delay_ms });
});
