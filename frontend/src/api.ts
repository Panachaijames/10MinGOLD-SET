export interface TimeframeState {
  timeframe_minutes: number;
  bar_open: string;
  bar_close: string;
  price: number;
  macd: number;
  signal: number;
  histogram: number;
  trend: "bullish" | "bearish";
  detected_at: string;
  detection_delay_ms: number;
  feed_fresh: boolean;
  /** True when the candle was closed by the wall clock (no next candle yet) and may still be re-evaluated. */
  provisional?: boolean;
  forming?: Candle | null;
}

export type Direction = "bullish" | "bearish";
export type AlertDirection = Direction | "info";

export interface StatusResponse {
  watcher: {
    running: boolean;
    connected: boolean;
    source: string;
    symbol: string;
    last_poll_at: string | null;
    last_error: string | null;
    started_at: string | null;
    directions?: Direction[];
    keep_awake?: boolean;
    clock_skew_upper_s?: number | null;
    last_offline_gap_s?: number | null;
    last_offline_gap_at?: string | null;
    delivery_alive?: boolean;
    timeframes: Record<string, TimeframeState>;
  };
  subscriptions: number;
  pending_pushes: number;
  latency: {
    samples: number;
    p50_ms: number | null;
    p95_ms: number | null;
    max_ms: number | null;
  };
  /** Present only when the PWA is served from the Supabase backend. */
  cloud?: {
    gold_last_seen: string | null;
    gold_cloud_last_seen: string | null;
    gold_cloud_dry_run: boolean | null;
    set_last_seen: string | null;
    set_update_mode: string | null;
    set_dry_run: boolean | null;
    push_last_seen: string | null;
  };
}

export interface AlertRecord {
  id: string;
  symbol: string;
  timeframe_minutes: number;
  direction: AlertDirection;
  /** Cloud rows carry the producer (gold_mt5, gold_cloud, set_tv, system) and pre-rendered text. */
  source?: string;
  title?: string;
  body?: string;
  bar_open: string;
  bar_close: string;
  price: number;
  macd: number;
  signal: number;
  histogram: number;
  detected_at: string;
  detection_delay_ms: number;
  push_accepted: number;
  device_received: number;
  first_device_received_at: string | null;
}

export interface Candle {
  time: string;          // candle OPEN, ISO-8601 UTC
  open: number;
  high: number;
  low: number;
  close: number;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  provisional?: boolean;
}

export interface CandleSeries {
  symbol: string;
  timeframe_minutes: number;
  candles: Candle[];
  forming?: Candle | null;
}

/** One MACD point per closed 15m bar for a SET ticker (no OHLC available from the free scanner). */
export interface SetMacdPoint {
  symbol: string;
  time: string;
  close: number | null;
  macd: number;
  signal: number;
  histogram: number;
}

export interface SetTickerState {
  symbol: string;
  timeframe_minutes: number;
  last_bar_time: string | null;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  update_mode: string | null;
  last_polled_at: string | null;
  last_error: string | null;
}

export interface PublicConfig {
  vapid_public_key: string;
  symbol: string;
  timeframes: number[];
  poll_interval_ms: number;
  line_configured?: boolean;
  line_bot_id?: string | null;
  line_bot_add_url?: string | null;
}

async function request<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("X-App-Token", token);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body.detail) detail = body.detail;
    } catch {
      // Keep the HTTP fallback.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export const api = {
  publicConfig: () => request<PublicConfig>("/api/public-config"),
  status: (token: string) => request<StatusResponse>("/api/status", token),
  alerts: (token: string) => request<{ alerts: AlertRecord[] }>("/api/alerts?limit=50", token),
  candles: (token: string, timeframe: number, limit = 200) =>
    request<CandleSeries>(`/api/candles?timeframe=${timeframe}&limit=${limit}`, token),
  subscribe: (token: string, subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean; subscription_id: number }>("/api/push/subscriptions", token, {
      method: "POST",
      body: JSON.stringify(subscription)
    }),
  unsubscribe: (token: string, endpoint: string) =>
    request<{ ok: boolean }>("/api/push/subscriptions", token, {
      method: "DELETE",
      body: JSON.stringify({ endpoint })
    }),
  testPush: (token: string) =>
    request<{ ok: boolean; subscriptions: number; accepted: number; failed: number }>("/api/push/test", token, {
      method: "POST"
    }),
  testLine: (token: string) =>
    request<{ ok: boolean; result: any }>("/api/line/test", token, {
      method: "POST"
    })
};
