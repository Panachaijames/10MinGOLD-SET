import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";
import { projectUrl, secretKeys } from "./auth.ts";

let cached: SupabaseClient | null = null;

/** Service client (secret key, bypasses RLS). Reused across invocations of a warm worker. */
export function adminClient(): SupabaseClient {
  if (cached) return cached;
  const key = secretKeys()[0];
  if (!key) throw new Error("No secret key available in SUPABASE_SECRET_KEYS");
  cached = createClient(projectUrl(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export async function getSetting<T>(client: SupabaseClient, key: string, fallback: T): Promise<T> {
  const { data, error } = await client.from("settings").select("value").eq("key", key).maybeSingle();
  if (error || !data) return fallback;
  return data.value as T;
}

export async function heartbeat(
  client: SupabaseClient,
  source: string,
  connected: boolean,
  details: Record<string, unknown>,
): Promise<void> {
  await client.from("heartbeats").upsert(
    { source, last_seen: new Date().toISOString(), connected, details, updated_at: new Date().toISOString() },
    { onConflict: "source" },
  );
}

export function corsHeaders(origin = "*"): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
