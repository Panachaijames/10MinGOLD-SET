import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { AlertRecord, CandleSeries, PublicConfig, SetMacdPoint, SetTickerState, StatusResponse, api } from "./api";

export type BackendKind = "legacy" | "supabase";

export interface SignInInput {
  token?: string;
  email?: string;
  password?: string;
}

export interface TestPushResult {
  subscriptions: number;
  accepted: number;
  failed: number;
}

/**
 * The PWA talks to one of two backends, chosen at build time:
 *  - legacy: the local FastAPI server (v1), authenticated with a shared APP_TOKEN;
 *  - supabase: Postgres + Edge Functions, authenticated with a Supabase Auth session.
 * Both return the same shapes so the UI does not care.
 */
export interface Backend {
  readonly kind: BackendKind;
  hasSession(): Promise<boolean>;
  signIn(input: SignInInput): Promise<void>;
  signOut(): Promise<void>;
  publicConfig(): Promise<PublicConfig>;
  status(): Promise<StatusResponse>;
  alerts(): Promise<AlertRecord[]>;
  subscribe(subscription: PushSubscriptionJSON): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  testPush(): Promise<TestPushResult>;
  testLine?(): Promise<{ ok: boolean; message?: string }>;
  /** Recent closed gold candles with MACD for one timeframe (oldest first). */
  candles(timeframe: number, limit?: number): Promise<CandleSeries>;
  /** SET tickers: latest scanner state; empty on the legacy backend. */
  setTickers(): Promise<SetTickerState[]>;
  /** SET tickers: MACD history points for one ticker; empty on the legacy backend. */
  setHistory(symbol: string, limit?: number): Promise<SetMacdPoint[]>;
  /** Optional live updates; returns an unsubscribe function. */
  onChange?(callback: () => void): () => void;
}

const TOKEN_KEY = "aurum-app-token";

class LegacyBackend implements Backend {
  readonly kind = "legacy" as const;

  private token(): string {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  async hasSession(): Promise<boolean> {
    return Boolean(this.token());
  }

  async signIn(input: SignInInput): Promise<void> {
    const value = (input.token || "").trim();
    if (!value) throw new Error("Enter the APP_TOKEN from the PC's .env file.");
    localStorage.setItem(TOKEN_KEY, value);
  }

  async signOut(): Promise<void> {
    localStorage.removeItem(TOKEN_KEY);
  }

  publicConfig(): Promise<PublicConfig> {
    return api.publicConfig();
  }

  status(): Promise<StatusResponse> {
    return api.status(this.token());
  }

  async alerts(): Promise<AlertRecord[]> {
    return (await api.alerts(this.token())).alerts;
  }

  async subscribe(subscription: PushSubscriptionJSON): Promise<void> {
    await api.subscribe(this.token(), subscription);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await api.unsubscribe(this.token(), endpoint);
  }

  testPush(): Promise<TestPushResult> {
    return api.testPush(this.token());
  }

  async testLine(): Promise<{ ok: boolean; message?: string }> {
    const res = await api.testLine(this.token());
    return { ok: res.ok, message: "LINE test notification delivered." };
  }

  candles(timeframe: number, limit = 200): Promise<CandleSeries> {
    return api.candles(this.token(), timeframe, limit);
  }

  async setTickers(): Promise<SetTickerState[]> {
    return [];
  }

  async setHistory(): Promise<SetMacdPoint[]> {
    return [];
  }
}

interface HeartbeatRow {
  source: string;
  last_seen: string;
  connected: boolean | null;
  details: Record<string, unknown>;
}

interface AlertViewRow {
  id: string;
  source: string;
  symbol: string;
  timeframe: number;
  direction: "bullish" | "bearish" | "info";
  bar_time: string;
  bar_close: string | null;
  price: number | null;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  title: string;
  body: string;
  detected_at: string;
  detection_delay_ms: number | null;
  created_at: string;
  push_accepted: number;
  device_received: number;
  first_device_received_at: string | null;
}

function platformFor(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    if (host.endsWith("push.apple.com")) return "apple";
    if (host.endsWith("fcm.googleapis.com")) return "fcm";
    if (host.endsWith("notify.windows.com")) return "wns";
    if (host.endsWith("push.services.mozilla.com")) return "mozilla";
  } catch {
    // fall through
  }
  return "other";
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))]);
}

class SupabaseBackend implements Backend {
  readonly kind = "supabase" as const;
  private readonly client: SupabaseClient;
  private symbolCache: string | null = null;

  constructor(url: string, publishableKey: string) {
    this.client = createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  private async symbol(): Promise<string> {
    if (!this.symbolCache) this.symbolCache = (await this.publicConfig()).symbol;
    return this.symbolCache;
  }

  async hasSession(): Promise<boolean> {
    const { data } = await this.client.auth.getSession();
    return Boolean(data.session);
  }

  async signIn(input: SignInInput): Promise<void> {
    const email = (input.email || "").trim();
    const password = input.password || "";
    if (!email || !password) throw new Error("Enter the email and password of the watcher account.");
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  private async heartbeats(): Promise<Record<string, HeartbeatRow>> {
    const { data, error } = await this.client.from("heartbeats").select("source,last_seen,connected,details");
    if (error) throw new Error(error.message);
    return Object.fromEntries(((data as HeartbeatRow[]) || []).map((row) => [row.source, row]));
  }

  async publicConfig(): Promise<PublicConfig> {
    const gold = (await this.heartbeats()).gold_mt5;
    const details = (gold?.details || {}) as { symbol?: string; timeframes?: Record<string, unknown> };
    return {
      vapid_public_key: __VAPID_PUBLIC_KEY__,
      symbol: details.symbol || "XAUUSDm",
      timeframes: Object.keys(details.timeframes || {}).map(Number).filter(Boolean),
      poll_interval_ms: 500
    };
  }

  async status(): Promise<StatusResponse> {
    const [heartbeats, subscriptions, pending, recent] = await Promise.all([
      this.heartbeats(),
      this.client.from("push_subscriptions").select("endpoint", { count: "exact", head: true }).eq("enabled", true),
      this.client.from("push_deliveries").select("id", { count: "exact", head: true }).eq("status", "pending"),
      this.client
        .from("alerts_with_delivery")
        .select("bar_close,first_device_received_at")
        .not("first_device_received_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(200)
    ]);
    const gold = heartbeats.gold_mt5;
    const details = (gold?.details || {}) as Partial<StatusResponse["watcher"]>;
    const goldFresh = Boolean(gold) && Date.now() - Date.parse(gold.last_seen) < 90_000;
    const latencies = ((recent.data as { bar_close: string | null; first_device_received_at: string | null }[]) || [])
      .filter((row) => row.bar_close && row.first_device_received_at)
      .map((row) => Math.max(0, Date.parse(row.first_device_received_at as string) - Date.parse(row.bar_close as string)));
    return {
      watcher: {
        running: goldFresh && Boolean(details.running ?? true),
        connected: goldFresh && Boolean(gold?.connected ?? details.connected),
        source: details.source || "mt5",
        symbol: details.symbol || "XAUUSDm",
        last_poll_at: details.last_poll_at ?? gold?.last_seen ?? null,
        last_error: goldFresh ? (details.last_error ?? null) : "No heartbeat from the laptop watcher",
        started_at: details.started_at ?? null,
        directions: details.directions,
        keep_awake: details.keep_awake,
        clock_skew_upper_s: details.clock_skew_upper_s,
        last_offline_gap_s: details.last_offline_gap_s,
        last_offline_gap_at: details.last_offline_gap_at,
        delivery_alive: Boolean(heartbeats.push_fanout),
        timeframes: details.timeframes || {}
      },
      subscriptions: subscriptions.count ?? 0,
      pending_pushes: pending.count ?? 0,
      latency: {
        samples: latencies.length,
        p50_ms: percentile(latencies, 0.5),
        p95_ms: percentile(latencies, 0.95),
        max_ms: latencies.length ? Math.round(Math.max(...latencies)) : null
      },
      cloud: {
        gold_last_seen: gold?.last_seen ?? null,
        set_last_seen: heartbeats.set_tv?.last_seen ?? null,
        set_update_mode: ((heartbeats.set_tv?.details || {}) as { update_mode?: string }).update_mode ?? null,
        set_dry_run: ((heartbeats.set_tv?.details || {}) as { dry_run?: boolean }).dry_run ?? null,
        push_last_seen: heartbeats.push_fanout?.last_seen ?? null
      }
    };
  }

  async alerts(): Promise<AlertRecord[]> {
    const { data, error } = await this.client
      .from("alerts_with_delivery")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return ((data as AlertViewRow[]) || []).map((row) => ({
      id: row.id,
      source: row.source,
      symbol: row.symbol,
      timeframe_minutes: row.timeframe,
      direction: row.direction,
      bar_open: row.bar_time,
      bar_close: row.bar_close || row.bar_time,
      price: row.price ?? 0,
      macd: row.macd ?? 0,
      signal: row.signal ?? 0,
      histogram: row.histogram ?? 0,
      title: row.title,
      body: row.body,
      detected_at: row.detected_at,
      detection_delay_ms: row.detection_delay_ms ?? 0,
      push_accepted: Number(row.push_accepted || 0),
      device_received: Number(row.device_received || 0),
      first_device_received_at: row.first_device_received_at
    }));
  }

  async subscribe(subscription: PushSubscriptionJSON): Promise<void> {
    if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      throw new Error("The browser returned an incomplete push subscription.");
    }
    const { error } = await this.client.from("push_subscriptions").upsert(
      {
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: navigator.userAgent.slice(0, 500),
        platform: platformFor(subscription.endpoint),
        enabled: true,
        last_seen_at: new Date().toISOString()
      },
      { onConflict: "endpoint" }
    );
    if (error) throw new Error(error.message);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const { error } = await this.client.from("push_subscriptions").update({ enabled: false }).eq("endpoint", endpoint);
    if (error) throw new Error(error.message);
  }

  async testPush(): Promise<TestPushResult> {
    const { data, error } = await this.client.functions.invoke("push-fanout", { body: { mode: "test" } });
    if (error) throw new Error(error.message || "push-fanout failed");
    const result = (data || {}) as Partial<TestPushResult>;
    return { subscriptions: result.subscriptions ?? 0, accepted: result.accepted ?? 0, failed: result.failed ?? 0 };
  }

  async testLine(): Promise<{ ok: boolean; message?: string }> {
    const { error } = await this.client.functions.invoke("push-fanout", { body: { mode: "test" } });
    if (error) throw new Error(error.message || "LINE test failed");
    return { ok: true, message: "LINE test triggered via cloud fan-out." };
  }

  async candles(timeframe: number, limit = 200): Promise<CandleSeries> {
    const symbol = await this.symbol();
    const { data, error } = await this.client
      .from("candles")
      .select("bar_time,open,high,low,close,macd,signal,histogram,provisional")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .order("bar_time", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    type Row = { bar_time: string; open: number | null; high: number | null; low: number | null; close: number; macd: number | null; signal: number | null; histogram: number | null; provisional: boolean };
    const rows = ((data as Row[]) || []).reverse();
    return {
      symbol,
      timeframe_minutes: timeframe,
      candles: rows.map((row) => ({
        time: row.bar_time,
        open: Number(row.open ?? row.close),
        high: Number(row.high ?? row.close),
        low: Number(row.low ?? row.close),
        close: Number(row.close),
        macd: row.macd,
        signal: row.signal,
        histogram: row.histogram,
        provisional: row.provisional
      }))
    };
  }

  async setTickers(): Promise<SetTickerState[]> {
    const { data, error } = await this.client
      .from("set_state")
      .select("symbol,timeframe,last_bar_time,last_macd,last_signal,last_hist,update_mode,last_polled_at,last_error")
      .order("symbol")
      .order("timeframe");
    if (error) throw new Error(error.message);
    type Row = { symbol: string; timeframe: number; last_bar_time: number | null; last_macd: number | null; last_signal: number | null; last_hist: number | null; update_mode: string | null; last_polled_at: string | null; last_error: string | null };
    return ((data as Row[]) || []).map((row) => ({
      symbol: row.symbol,
      timeframe_minutes: row.timeframe,
      last_bar_time: row.last_bar_time ? new Date(Number(row.last_bar_time) * 1000).toISOString() : null,
      macd: row.last_macd,
      signal: row.last_signal,
      histogram: row.last_hist,
      update_mode: row.update_mode,
      last_polled_at: row.last_polled_at,
      last_error: row.last_error
    }));
  }

  async setHistory(symbol: string, limit = 200): Promise<SetMacdPoint[]> {
    const { data, error } = await this.client
      .from("set_macd_history")
      .select("bar_time,close,macd,signal,histogram")
      .eq("symbol", symbol)
      .order("bar_time", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    type Row = { bar_time: string; close: number | null; macd: number; signal: number; histogram: number };
    return ((data as Row[]) || []).reverse().map((row) => ({
      symbol,
      time: row.bar_time,
      close: row.close,
      macd: row.macd,
      signal: row.signal,
      histogram: row.histogram
    }));
  }

  onChange(callback: () => void): () => void {
    // A unique topic per subscription: channel(topic) returns an existing channel with the same
    // name, so a resubscribe racing a still-leaving channel would otherwise silently die.
    const channel: RealtimeChannel = this.client
      .channel(`aurum-live-${Math.random().toString(36).slice(2, 10)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, callback)
      .on("postgres_changes", { event: "*", schema: "public", table: "heartbeats" }, callback)
      .on("postgres_changes", { event: "*", schema: "public", table: "candles" }, callback)
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}

export function createBackend(): Backend {
  if (__SUPABASE_URL__ && __SUPABASE_PUBLISHABLE_KEY__) {
    return new SupabaseBackend(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__);
  }
  return new LegacyBackend();
}
