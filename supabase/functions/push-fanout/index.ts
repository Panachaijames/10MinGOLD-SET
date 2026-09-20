/// <reference path="../deno.d.ts" />
// Web Push fan-out. Called by:
//   - the alerts INSERT trigger (ops.alerts_notify -> pg_net, body {type:'INSERT', record})
//   - pg_cron ops.push_sweep() with {mode:'sweep'} to retry pending deliveries
//   - the PWA "Send test" button with {mode:'test'} and a user JWT
// Responds 202 quickly and does the sending in the background (EdgeRuntime.waitUntil).
import {
  ApplicationServer,
  importVapidKeys,
  PushMessageError,
  Urgency,
  type PushSubscription,
} from "@negrel/webpush";
import { isSecretCaller, isUserCaller, unauthorized } from "../_shared/auth.ts";
import { adminClient, corsHeaders, getSetting, heartbeat } from "../_shared/db.ts";
import {
  recipientsFor,
  type NotificationPrefs,
  type Recipient,
  type WatchRow,
} from "../_shared/notify.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
// Ambient fallback for IDEs without the Deno extension active
declare const Deno: {
  env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

interface AlertRow {
  id: string;
  source: string;
  symbol: string;
  timeframe: number;
  direction: string;
  bar_time: string;
  bar_close: string | null;
  title: string;
  body: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  platform: string | null;
}

interface DeliveryRow {
  id: string;
  alert_id: string | null;
  endpoint: string;
  kind: string;
  attempts: number;
  receipt_token_hash: string;
}

let serverPromise: Promise<ApplicationServer> | null = null;

function applicationServer(): Promise<ApplicationServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const raw = Deno.env.get("VAPID_KEYS_JWK");
      if (!raw) throw new Error("VAPID_KEYS_JWK secret is not set (JSON with publicKey/privateKey JWKs)");
      const vapidKeys = await importVapidKeys(JSON.parse(raw));
      return ApplicationServer.new({
        contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:alerts@example.com",
        vapidKeys,
      });
    })();
  }
  return serverPromise;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function topicFor(alert: AlertRow): string {
  const raw = `${alert.symbol}-m${alert.timeframe}-${alert.direction.slice(0, 4)}`.toLowerCase();
  return raw.replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
}

function buildPayload(alert: AlertRow | null, delivery: { id: string; token: string }, kind: string) {
  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? "/").replace(/\/?$/, "/");
  const receiptUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/push-receipt`;
  const title = alert?.title ?? "Aurum Signal test";
  const body = alert?.body ?? "Web Push is connected. This device can receive alerts with the app closed.";
  const navigate = alert ? `${appUrl}?alert=${encodeURIComponent(alert.id)}` : appUrl;
  const tag = alert ? topicFor(alert) : `test-${delivery.id.slice(0, 8)}`;
  return {
    // Declarative Web Push (iOS 18.4+) renders this directly; other browsers hand the same
    // JSON to the service worker. No app_badge until it is verified on the real device.
    web_push: 8030,
    notification: { title, body, navigate, tag, silent: false },
    title,
    body,
    kind,
    eventId: alert?.id ?? `test:${delivery.id}`,
    symbol: alert?.symbol,
    timeframe: alert ? `M${alert.timeframe}` : undefined,
    direction: alert?.direction,
    barClose: alert?.bar_close,
    url: navigate,
    deliveryId: delivery.id,
    receiptToken: delivery.token,
    receiptUrl,
    sentAt: new Date().toISOString(),
  };
}

async function sendOne(
  subscription: SubscriptionRow,
  payload: Record<string, unknown>,
  ttl: number,
  topic: string | undefined,
): Promise<{ ok: boolean; status?: number; error?: string; gone?: boolean }> {
  try {
    const server = await applicationServer();
    const target: PushSubscription = {
      endpoint: subscription.endpoint,
      keys: { auth: subscription.auth, p256dh: subscription.p256dh },
    };
    await server.subscribe(target).pushTextMessage(JSON.stringify(payload), { ttl, urgency: Urgency.High, topic });
    return { ok: true };
  } catch (error) {
    if (error instanceof PushMessageError) {
      const status = error.response.status;
      return { ok: false, status, gone: error.isGone() || status === 404 || status === 410, error: `HTTP ${status}` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ownerIds(client: ReturnType<typeof adminClient>): Promise<Set<string>> {
  const { data } = await client.from("app_members").select("user_id").eq("is_owner", true).is("revoked_at", null);
  return new Set(((data ?? []) as { user_id: string }[]).map((row) => row.user_id));
}

/**
 * Who asked for this alert, or null when it belongs to everybody.
 *
 * Gold, SET and system alerts are the deployment's own and always went to every enrolled device;
 * that is unchanged. A watchlist alert is one member's, and now carries their rules with it: a
 * muted instrument, a direction they do not trade, or their quiet hours all drop them from the
 * audience. The alert itself is still written, charted and listed in the history either way.
 */
async function audienceFor(
  client: ReturnType<typeof adminClient>,
  alert: AlertRow | null,
): Promise<Recipient[] | null> {
  if (!alert || alert.source !== "watchlist") return null;
  const { data, error } = await client
    .from("watchlist")
    .select("user_id,notify,directions,channels")
    .eq("symbol", alert.symbol)
    .eq("timeframe", alert.timeframe)
    .eq("enabled", true);
  if (error) throw error;
  const rows = (data ?? []) as WatchRow[];
  if (!rows.length) return [];

  const { data: prefRows } = await client
    .from("notification_prefs")
    .select("user_id,quiet_from,quiet_to,time_zone,line_user_id")
    .in("user_id", [...new Set(rows.map((row) => row.user_id))]);
  const prefsByUser = new Map(
    ((prefRows ?? []) as NotificationPrefs[]).map((row) => [row.user_id, row]),
  );
  return recipientsFor(
    rows,
    prefsByUser,
    alert.direction,
    Date.now(),
    Deno.env.get("LINE_USER_ID") ?? null,
    await ownerIds(client),
  );
}

async function fanOut(alert: AlertRow | null, kind: "alert" | "test", audience?: Recipient[] | null) {
  const client = adminClient();
  const ttl = await getSetting<number>(client, "push_ttl_seconds", 600);
  const targets = audience === undefined ? await audienceFor(client, alert) : audience;
  // Nobody wants this one pushed: everybody watching it is muted, asleep, or takes the other
  // direction. The last watcher can also have removed it between the scan and the fan-out.
  const pushUsers = targets?.filter((recipient) => recipient.channels.has("push")).map((r) => r.userId);
  if (pushUsers !== undefined && pushUsers.length === 0) {
    return { subscriptions: 0, accepted: 0, failed: 0, skipped: 0 };
  }
  let query = client
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth,platform")
    .eq("enabled", true);
  if (pushUsers !== undefined) query = query.in("user_id", pushUsers);
  const { data: subscriptions, error } = await query;
  if (error) throw error;
  const result = { subscriptions: subscriptions?.length ?? 0, accepted: 0, failed: 0, skipped: 0 };
  const topic = alert ? topicFor(alert) : undefined;

  for (const subscription of (subscriptions ?? []) as SubscriptionRow[]) {
    const token = randomToken();
    const { data: inserted } = await client
      .from("push_deliveries")
      .upsert(
        {
          alert_id: alert?.id ?? null,
          endpoint: subscription.endpoint,
          kind,
          status: "pending",
          receipt_token_hash: await sha256Hex(token),
        },
        { onConflict: "alert_id,endpoint", ignoreDuplicates: true },
      )
      .select("id");
    // A row already existed for this alert+device: another invocation owns it (sweeper handles retries).
    if (!inserted?.length) {
      if (alert) {
        result.skipped++;
        continue;
      }
    }
    const deliveryId = inserted?.[0]?.id as string | undefined;
    if (!deliveryId) {
      result.skipped++;
      continue;
    }
    const outcome = await sendOne(subscription, buildPayload(alert, { id: deliveryId, token }, kind), ttl, topic);
    await recordOutcome(client, deliveryId, subscription.endpoint, outcome, 1);
    outcome.ok ? result.accepted++ : result.failed++;
  }
  await heartbeat(client, "push_fanout", true, { last_kind: kind, ...result });
  return result;
}

async function recordOutcome(
  client: ReturnType<typeof adminClient>,
  deliveryId: string,
  endpoint: string,
  outcome: { ok: boolean; status?: number; error?: string; gone?: boolean },
  attempts: number,
) {
  const now = new Date().toISOString();
  if (outcome.ok) {
    await client.from("push_deliveries").update({ status: "accepted", accepted_at: now, attempts, last_error: null }).eq("id", deliveryId);
    await client.from("push_subscriptions").update({ last_ok_at: now, last_error: null, fail_count: 0 }).eq("endpoint", endpoint);
    return;
  }
  const permanent = outcome.gone || [400, 401, 403, 413].includes(outcome.status ?? 0);
  await client
    .from("push_deliveries")
    .update({ status: permanent ? "failed" : "pending", attempts, last_error: outcome.error ?? "unknown" })
    .eq("id", deliveryId);
  if (outcome.gone) {
    await client.from("push_subscriptions").update({ enabled: false, last_error: outcome.error ?? "gone" }).eq("endpoint", endpoint);
  } else {
    await client.from("push_subscriptions").update({ last_error: outcome.error ?? "unknown" }).eq("endpoint", endpoint);
  }
}

async function sweep() {
  const client = adminClient();
  const ttl = await getSetting<number>(client, "push_ttl_seconds", 600);
  const { data: pending, error } = await client
    .from("push_deliveries")
    .select("id,alert_id,endpoint,kind,attempts,receipt_token_hash")
    .eq("status", "pending")
    .lt("attempts", 6)
    .gte("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .limit(50);
  if (error) throw error;
  const result = { pending: pending?.length ?? 0, accepted: 0, failed: 0 };
  for (const delivery of (pending ?? []) as DeliveryRow[]) {
    const [{ data: subscription }, { data: alert }] = await Promise.all([
      client.from("push_subscriptions").select("endpoint,p256dh,auth,platform").eq("endpoint", delivery.endpoint).eq("enabled", true).maybeSingle(),
      delivery.alert_id
        ? client.from("alerts").select("id,source,symbol,timeframe,direction,bar_time,bar_close,title,body").eq("id", delivery.alert_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (!subscription) {
      await client.from("push_deliveries").update({ status: "dead", last_error: "subscription disabled" }).eq("id", delivery.id);
      continue;
    }
    // A fresh receipt token is issued for the retry so the hash on file stays valid.
    const token = randomToken();
    await client.from("push_deliveries").update({ receipt_token_hash: await sha256Hex(token) }).eq("id", delivery.id);
    const alertRow = (alert as AlertRow | null) ?? null;
    const outcome = await sendOne(
      subscription as SubscriptionRow,
      buildPayload(alertRow, { id: delivery.id, token }, delivery.kind),
      ttl,
      alertRow ? topicFor(alertRow) : undefined,
    );
    await recordOutcome(client, delivery.id, delivery.endpoint, outcome, delivery.attempts + 1);
    outcome.ok ? result.accepted++ : result.failed++;
  }
  await heartbeat(client, "push_fanout", true, { last_kind: "sweep", ...result });
  return result;
}

/**
 * LINE is one channel belonging to the owner, so a guest's watchlist must not appear in it.
 * Gold, SET and system alerts are the deployment's own and always go; a watchlist alert goes
 * only when the owner is one of the people watching that instrument.
 */
function lineDestinations(alert: AlertRow | null, audience: Recipient[] | null): string[] {
  // Gold, SET and system alerts keep going to the project's own LINE destination, as before.
  if (audience === null) {
    const owner = Deno.env.get("LINE_USER_ID");
    return owner ? [owner] : [];
  }
  const destinations = new Set<string>();
  for (const recipient of audience) {
    if (recipient.channels.has("line") && recipient.lineUserId) destinations.add(recipient.lineUserId);
  }
  return [...destinations];
}

/** What happened on the LINE leg, so a silent misconfiguration cannot look like success. */
export interface LineResult {
  configured: boolean;
  ok: boolean;
  status?: number;
  error?: string;
}

async function sendLineAlert(alert: AlertRow | null, toUserId?: string): Promise<LineResult> {
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const userId = toUserId ?? Deno.env.get("LINE_USER_ID");
  if (!token || !userId) {
    // The laptop reads these from .env; the function has its own secrets and cannot see that
    // file, so this is the usual reason LINE works locally and not from the cloud.
    const missing = [!token ? "LINE_CHANNEL_ACCESS_TOKEN" : null, !userId ? "a LINE destination" : null]
      .filter(Boolean)
      .join(" and ");
    console.error(`LINE is not configured on this function: ${missing} not set`);
    return { configured: false, ok: false, error: `${missing} not set on the function` };
  }

  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? "/").replace(/\/?$/, "/");
  const lines: string[] = [];
  if (alert) {
    const emoji = alert.direction === "bullish" ? "🟢" : alert.direction === "bearish" ? "🔴" : "ℹ️";
    lines.push(`${emoji} AURUM SIGNAL: ${alert.symbol} M${alert.timeframe}`);
    lines.push(`Direction: ${alert.direction.toUpperCase()} MACD Cross`);
    lines.push(alert.body);
    if (!appUrl.startsWith("http://localhost")) {
      lines.push(`Chart: ${appUrl}?alert=${encodeURIComponent(alert.id)}`);
    }
  } else {
    lines.push("🔔 Aurum Signal: LINE Notification Test (Cloud)");
    lines.push("Status: Connected to Supabase Cloud Fan-Out");
  }

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text: lines.join("\n") }],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error("LINE push error:", res.status, detail);
      return { configured: true, ok: false, status: res.status, error: detail };
    }
    return { configured: true, ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("LINE push network exception:", detail);
    return { configured: true, ok: false, error: detail };
  }
}

Deno.serve(async (req) => {
  const headers = corsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const mode = (body.mode as string | undefined) ?? (body.type === "INSERT" && body.record ? "webhook" : "unknown");

  const secret = isSecretCaller(req);
  if (mode === "test") {
    if (!secret && !(await isUserCaller(req))) return unauthorized();
    // The user is waiting for the result, so send synchronously.
    const [result, line] = await Promise.all([fanOut(null, "test"), sendLineAlert(null)]);
    return Response.json({ ok: true, ...result, line }, { headers });
  }
  if (!secret) return unauthorized();

  if (mode === "webhook") {
    const record = body.record as AlertRow;
    // Resolved once and handed to both legs: the two must agree about who wanted this alert,
    // and it saves repeating the watchlist and preference queries.
    const audience = await audienceFor(adminClient(), record).catch((error) => {
      console.error("audience lookup failed", error);
      return null;
    });
    const work = Promise.all([
      fanOut(record, "alert", audience).catch((error) => console.error("fan-out failed", error)),
      Promise.all(
        lineDestinations(record, audience).map((destination) =>
          sendLineAlert(record, destination).catch((error) => console.error("LINE fan-out failed", error))
        ),
      ),
    ]);
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
    else await work;
    return Response.json({ accepted: true, alert_id: record.id }, { status: 202, headers });
  }
  if (mode === "sweep") {
    const result = await sweep();
    return Response.json({ ok: true, ...result }, { headers });
  }
  return Response.json({ error: `unknown mode ${mode}` }, { status: 400, headers });
});
