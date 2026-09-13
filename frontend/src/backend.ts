import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { AlertRecord, CandleSeries, PublicConfig, SetMacdPoint, SetTickerState, StatusResponse, api } from "./api";

export type BackendKind = "legacy" | "supabase";

export interface SignInInput {
  token?: string;
  email?: string;
  password?: string;
}

export interface AccessCode {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  uses: number;
  claimed_at: string | null;
  revoked_at: string | null;
}

export interface AccessMember {
  user_id: string;
  label: string;
  is_owner: boolean;
  granted_at: string;
  revoked_at: string | null;
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
  /** `light` skips the expensive latency sample and counts, reusing the last values. */
  status(options?: { light?: boolean }): Promise<StatusResponse>;
  alerts(): Promise<AlertRecord[]>;
  subscribe(subscription: PushSubscriptionJSON): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  testPush(): Promise<TestPushResult>;
  testLine?(): Promise<{ ok: boolean; message?: string }>;
  /** Recent closed candles for one explicit symbol/timeframe pair (oldest first). */
  candles(symbol: string, timeframe: number, limit?: number): Promise<CandleSeries>;
  /** SET tickers: latest scanner state; empty on the legacy backend. */
  setTickers(): Promise<SetTickerState[]>;
  /** SET tickers: MACD history points for one ticker; empty on the legacy backend. */
  setHistory(symbol: string, limit?: number): Promise<SetMacdPoint[]>;
  /** Sign in as a guest holding one of the owner's passcodes. */
  redeemPasscode?(code: string): Promise<void>;
  /** True when the signed-in account owns the deployment and may issue passcodes. */
  isOwner?(): Promise<boolean>;
  issuePasscode?(input: { label: string; expiresInDays: number | null }): Promise<string>;
  listAccess?(): Promise<{ codes: AccessCode[]; members: AccessMember[] }>;
  revokeAccess?(input: { codeId?: string; memberId?: string }): Promise<void>;
  /** Optional live updates; returns an unsubscribe function. */
  onChange?(callback: (table: string) => void): () => void;
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

  candles(_symbol: string, timeframe: number, limit = 200): Promise<CandleSeries> {
    // The local FastAPI endpoint is backed by the one configured MT5 gold symbol. The explicit
    // symbol argument keeps the interface consistent with Supabase without pretending that the
    // legacy process can serve SET or Bitcoin candles.
    return api.candles(this.token(), timeframe, limit);
  }

  async setTickers(): Promise<SetTickerState[]> {
    return [];
  }

  async setHistory(): Promise<SetMacdPoint[]> {
    return [];
  }
}

interface StatusExtras {
  subscriptions: number;
  pending: number;
  latency: StatusResponse["latency"];
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

/**
 * functions.invoke reports a non-2xx as a generic "returned a non-2xx status code" and hides the
 * body on error.context, so the reason a passcode was refused would never reach the guest.
 */
async function functionError(error: unknown, fallback: string): Promise<string> {
  const response = (error as { context?: Response } | null)?.context;
  if (response && typeof response.json === "function") {
    try {
      const body = await response.clone().json();
      if (body?.error) return String(body.error);
    } catch {
      // Not JSON; fall back to the generic message below.
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

class SupabaseBackend implements Backend {
  readonly kind = "supabase" as const;
  private readonly client: SupabaseClient;
  private cachedExtras: StatusExtras | null = null;

  constructor(url: string, publishableKey: string) {
    this.client = createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
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
    const [heartbeats, goldSetting] = await Promise.all([
      this.heartbeats(),
      this.client.from("settings").select("value").eq("key", "gold_symbol").maybeSingle()
    ]);
    if (goldSetting.error) throw new Error(goldSetting.error.message);
    const gold = heartbeats.gold_mt5;
    const details = (gold?.details || {}) as {
      symbol?: string;
      timeframes?: Record<string, unknown>;
      line_configured?: boolean;
      line_bot_id?: string | null;
      line_bot_add_url?: string | null;
    };
    const configuredSymbol = typeof goldSetting.data?.value === "string" ? goldSetting.data.value : null;
    return {
      vapid_public_key: __VAPID_PUBLIC_KEY__,
      symbol: details.symbol || configuredSymbol || "XAUUSDm",
      timeframes: Object.keys(details.timeframes || {}).map(Number).filter(Boolean),
      poll_interval_ms: 500,
      line_configured: details.line_configured !== undefined ? Boolean(details.line_configured) : true,
      line_bot_id: details.line_bot_id || __LINE_BOT_ID__ || "@688fbhby",
      line_bot_add_url: details.line_bot_add_url || __LINE_BOT_ADD_URL__ || "https://lin.ee/tQIeBjo"
    };
  }

  /**
   * Counts and the 200-row latency sample: everything in a status refresh that is not the
   * heartbeat itself. A watcher heartbeat only moves the forming candle, so re-running these
   * on every one of them is what made a faster heartbeat expensive.
   */
  private async statusExtras(): Promise<StatusExtras> {
    const [subscriptions, pending, recent] = await Promise.all([
      this.client.from("push_subscriptions").select("endpoint", { count: "exact", head: true }).eq("enabled", true),
      this.client.from("push_deliveries").select("id", { count: "exact", head: true }).eq("status", "pending"),
      this.client
        .from("alerts_with_delivery")
        .select("bar_close,first_device_received_at")
        .not("first_device_received_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(200)
    ]);
    const latencies = ((recent.data as { bar_close: string | null; first_device_received_at: string | null }[]) || [])
      .filter((row) => row.bar_close && row.first_device_received_at)
      .map((row) => Math.max(0, Date.parse(row.first_device_received_at as string) - Date.parse(row.bar_close as string)));
    return {
      subscriptions: subscriptions.count ?? 0,
      pending: pending.count ?? 0,
      latency: {
        samples: latencies.length,
        p50_ms: percentile(latencies, 0.5),
        p95_ms: percentile(latencies, 0.95),
        max_ms: latencies.length ? Math.round(Math.max(...latencies)) : null
      }
    };
  }

  async status(options?: { light?: boolean }): Promise<StatusResponse> {
    const reuse = Boolean(options?.light) && this.cachedExtras !== null;
    const [heartbeats, extras] = await Promise.all([
      this.heartbeats(),
      reuse ? Promise.resolve(this.cachedExtras as StatusExtras) : this.statusExtras()
    ]);
    this.cachedExtras = extras;
    const gold = heartbeats.gold_mt5;
    const details = (gold?.details || {}) as Partial<StatusResponse["watcher"]>;
    const goldFresh = Boolean(gold) && Date.now() - Date.parse(gold.last_seen) < 90_000;
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
      subscriptions: extras.subscriptions,
      pending_pushes: extras.pending,
      latency: extras.latency,
      cloud: {
        gold_last_seen: gold?.last_seen ?? null,
        gold_cloud_last_seen: heartbeats.gold_cloud?.last_seen ?? null,
        gold_cloud_dry_run: ((heartbeats.gold_cloud?.details || {}) as { dry_run?: boolean }).dry_run ?? null,
        set_last_seen: heartbeats.set_tv?.last_seen ?? null,
        tv_webhook_last_seen: heartbeats.set_tv_webhook?.last_seen ?? null,
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

  /**
   * A guest signs in anonymously, which grants a user id and nothing at all, then redeems the
   * passcode to be recorded as a member. Every table's policy checks membership, so a failed
   * redemption leaves a session that can read nothing; it is signed out rather than left behind.
   */
  async redeemPasscode(code: string): Promise<void> {
    const { data: existing } = await this.client.auth.getSession();
    const hadSession = Boolean(existing.session);
    if (!hadSession) {
      const { error } = await this.client.auth.signInAnonymously();
      if (error) {
        throw new Error(
          error.message.toLowerCase().includes("disabled")
            ? "Guest sign-in is switched off for this project. Enable anonymous sign-ins in Supabase Auth settings."
            : error.message
        );
      }
    }
    const { data, error } = await this.client.functions.invoke("access-code", { body: { action: "redeem", code } });
    const failure = error
      ? await functionError(error, "That passcode is not valid.")
      : (data as { error?: string } | null)?.error;
    if (failure) {
      // A session that redeemed nothing can read nothing, so do not leave it behind.
      if (!hadSession) await this.client.auth.signOut();
      throw new Error(failure);
    }
  }

  async isOwner(): Promise<boolean> {
    const { data, error } = await this.client.rpc("is_owner");
    return !error && data === true;
  }

  async issuePasscode(input: { label: string; expiresInDays: number | null }): Promise<string> {
    const { data, error } = await this.client.functions.invoke("access-code", {
      body: { action: "issue", label: input.label, expires_in_days: input.expiresInDays }
    });
    if (error) throw new Error(await functionError(error, "Could not issue a passcode."));
    const payload = (data || {}) as { code?: string; error?: string };
    if (payload.error || !payload.code) throw new Error(payload.error || "No passcode was returned.");
    return payload.code;
  }

  async listAccess(): Promise<{ codes: AccessCode[]; members: AccessMember[] }> {
    const [codes, members] = await Promise.all([
      this.client.from("access_codes").select("*").order("created_at", { ascending: false }).limit(50),
      this.client.from("app_members").select("*").order("granted_at", { ascending: false }).limit(50)
    ]);
    return {
      codes: (codes.data as AccessCode[]) || [],
      members: (members.data as AccessMember[]) || []
    };
  }

  async revokeAccess(input: { codeId?: string; memberId?: string }): Promise<void> {
    const { data, error } = await this.client.functions.invoke("access-code", {
      body: { action: "revoke", code_id: input.codeId, member_id: input.memberId }
    });
    if (error) throw new Error(await functionError(error, "Could not revoke that."));
    const payload = (data || {}) as { error?: string };
    if (payload.error) throw new Error(payload.error);
  }

  async testLine(): Promise<{ ok: boolean; message?: string }> {
    const { data, error } = await this.client.functions.invoke("push-fanout", { body: { mode: "test" } });
    if (error) throw new Error(error.message || "LINE test failed");
    // The cloud function reads its own secrets, so LINE can be unconfigured there while it works
    // from the laptop. Report that instead of claiming the test was sent.
    const line = (data as { line?: { configured?: boolean; ok?: boolean; status?: number; error?: string } } | null)?.line;
    if (!line) {
      throw new Error("push-fanout did not report a LINE result. Redeploy it so the test can tell you what happened.");
    }
    if (!line.configured) {
      throw new Error(`LINE is not set up on the cloud function: ${line.error ?? "secrets missing"}.`);
    }
    if (!line.ok) {
      throw new Error(`LINE rejected the message${line.status ? ` (HTTP ${line.status})` : ""}: ${line.error ?? "unknown error"}`);
    }
    return { ok: true, message: "LINE test delivered from the cloud fan-out." };
  }

  async candles(symbol: string, timeframe: number, limit = 200): Promise<CandleSeries> {
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
    const [stateResult, settingResult] = await Promise.all([
      this.client
        .from("set_state")
        .select("symbol,timeframe,last_bar_time,last_macd,last_signal,last_hist,update_mode,last_polled_at,last_error"),
      this.client.from("settings").select("value").eq("key", "set_tickers").maybeSingle()
    ]);
    if (stateResult.error) throw new Error(stateResult.error.message);
    if (settingResult.error) throw new Error(settingResult.error.message);
    type Row = { symbol: string; timeframe: number; last_bar_time: number | null; last_macd: number | null; last_signal: number | null; last_hist: number | null; update_mode: string | null; last_polled_at: string | null; last_error: string | null };
    const rows = (stateResult.data as Row[]) || [];
    const stateBySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const configured = Array.isArray(settingResult.data?.value)
      ? settingResult.data.value.filter((value): value is string => typeof value === "string" && value.startsWith("SET:"))
      : [];
    // Settings are the source of truth. This makes all configured chart choices visible before
    // set-scan has written its first state row; fall back to state for older deployments.
    const symbols = [...new Set(configured.length ? configured : rows.map((row) => row.symbol))];
    return symbols.map((symbol) => stateBySymbol.get(symbol) ?? {
      symbol,
      timeframe: 15,
      last_bar_time: null,
      last_macd: null,
      last_signal: null,
      last_hist: null,
      update_mode: null,
      last_polled_at: null,
      last_error: null
    }).map((row) => ({
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

  onChange(callback: (table: string) => void): () => void {
    // A unique topic per subscription: channel(topic) returns an existing channel with the same
    // name, so a resubscribe racing a still-leaving channel would otherwise silently die.
    const channel: RealtimeChannel = this.client
      .channel(`aurum-live-${Math.random().toString(36).slice(2, 10)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => callback("alerts"))
      .on("postgres_changes", { event: "*", schema: "public", table: "heartbeats" }, () => callback("heartbeats"))
      .on("postgres_changes", { event: "*", schema: "public", table: "candles" }, () => callback("candles"))
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
