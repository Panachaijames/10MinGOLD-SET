// Caller authentication for functions deployed with verify_jwt = false.
//
// Two kinds of callers exist:
//   - machines (pg_cron / pg_net, Database triggers, the laptop) send the project's secret
//     key on the `apikey` header (and as a Bearer token);
//   - the PWA sends the signed-in user's JWT as `Authorization: Bearer <jwt>` plus the
//     publishable key on `apikey`.
import { createClient } from "npm:@supabase/supabase-js@2.115.0";

function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return [parsed];
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    if (parsed && typeof parsed === "object") return Object.values(parsed).filter((v) => typeof v === "string") as string[];
  } catch {
    return [raw];
  }
  return [];
}

export function secretKeys(): string[] {
  const keys = parseKeyList(Deno.env.get("SUPABASE_SECRET_KEYS"));
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) keys.push(legacy);
  return keys;
}

export function publishableKey(): string {
  return parseKeyList(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"))[0] ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
}

export function projectUrl(): string {
  return Deno.env.get("SUPABASE_URL") ?? "";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function callerCredentials(req: Request): { apikey: string | null; bearer: string | null } {
  const apikey = req.headers.get("apikey");
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? null;
  return { apikey, bearer };
}

export function isSecretCaller(req: Request): boolean {
  const { apikey, bearer } = callerCredentials(req);
  const secrets = secretKeys();
  return [apikey, bearer].some((candidate) => !!candidate && secrets.some((s) => timingSafeEqual(s, candidate)));
}

/** True when the Bearer token is a valid Supabase Auth user session. */
export async function isUserCaller(req: Request): Promise<boolean> {
  const { bearer } = callerCredentials(req);
  if (!bearer || bearer.startsWith("sb_")) return false;
  const client = createClient(projectUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data, error } = await client.auth.getUser(bearer);
  return !error && !!data?.user;
}

/**
 * The caller's user id when they hold a session AND membership.
 *
 * A signed-in account is not access: an anonymous sign-in that never redeemed a passcode has a
 * valid JWT and no membership at all, and a revoked guest keeps their JWT until it expires. Any
 * function that spends the project's resources on a caller's behalf checks membership, not
 * merely authentication.
 */
export async function callerMember(req: Request): Promise<{ userId: string } | null> {
  const { bearer } = callerCredentials(req);
  if (!bearer || bearer.startsWith("sb_")) return null;
  const client = createClient(projectUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data, error } = await client.auth.getUser(bearer);
  if (error || !data?.user) return null;
  const { data: member, error: memberError } = await client.rpc("is_member");
  if (memberError || member !== true) return null;
  return { userId: data.user.id };
}

export function unauthorized(detail = "unauthorized"): Response {
  return Response.json({ error: detail }, { status: 401 });
}
