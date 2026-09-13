// Passcodes: the owner issues them, a guest redeems one to gain access.
//
// Access is membership in public.app_members, not merely holding a Supabase session, so the
// gate is enforced by RLS on every table rather than by the app being polite. A guest signs in
// (anonymously, or with their own email) which gives them a user id and nothing else, then
// redeems a passcode here to have that id recorded as a member.
//
// The passcode is only ever stored as a SHA-256 hash. It is shown to the owner once at issue
// time and cannot be recovered afterwards, so a leaked database does not leak working codes.
import { callerCredentials, publishableKey, projectUrl } from "../_shared/auth.ts";
import { adminClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const MAX_LABEL = 40;

/** Unambiguous alphabet: no O/0, I/1, so a code read aloud or copied by hand still works. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newPasscode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const body = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

async function hashOf(code: string): Promise<string> {
  const normalised = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed-in caller, from their own JWT. Returns null for machines and for no session. */
async function caller(req: Request): Promise<{ id: string; email: string | null } | null> {
  const { bearer } = callerCredentials(req);
  if (!bearer || bearer.startsWith("sb_")) return null;
  const client = createClient(projectUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const { data, error } = await client.auth.getUser(bearer);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

Deno.serve(async (req) => {
  const headers = corsHeaders();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  // The PWA calls this from the browser, which sends a preflight before any POST carrying an
  // Authorization header. Without this the request is blocked before it is ever sent.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers });

  const user = await caller(req);
  if (!user) return json({ error: "sign in first" }, 401);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const admin = adminClient();

  const { data: membership } = await admin
    .from("app_members")
    .select("is_owner,revoked_at")
    .eq("user_id", user.id)
    .maybeSingle();
  const isOwner = Boolean(membership?.is_owner) && !membership?.revoked_at;

  // ------------------------------------------------------------------ issue
  if (action === "issue") {
    if (!isOwner) return json({ error: "only the owner can issue passcodes" }, 403);
    const label = String(body.label ?? "guest").slice(0, MAX_LABEL) || "guest";
    // Deliberately fixed at one. A passcode is for a single device: the first to redeem it keeps
    // it, and the same code offered anywhere else is refused.
    const maxUses = 1;
    const days = Number(body.expires_in_days);
    const expiresAt = Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString()
      : null;

    const code = newPasscode();
    const { data, error } = await admin
      .from("access_codes")
      .insert({ code_hash: await hashOf(code), label, max_uses: maxUses, expires_at: expiresAt })
      .select("id,label,max_uses,expires_at")
      .single();
    if (error) return json({ error: error.message }, 500);
    // The only time the plaintext exists outside the owner's screen.
    return json({ ok: true, code, ...data });
  }

  // ------------------------------------------------------------------ revoke
  if (action === "revoke") {
    if (!isOwner) return json({ error: "only the owner can revoke" }, 403);
    const codeId = body.code_id ? String(body.code_id) : null;
    const memberId = body.member_id ? String(body.member_id) : null;
    const now = new Date().toISOString();
    if (codeId) {
      const { error } = await admin.from("access_codes").update({ revoked_at: now }).eq("id", codeId);
      if (error) return json({ error: error.message }, 500);
    }
    if (memberId) {
      // Never let the owner lock themselves out by revoking their own membership.
      if (memberId === user.id) return json({ error: "that is your own access" }, 400);
      const { error } = await admin.from("app_members").update({ revoked_at: now }).eq("user_id", memberId);
      if (error) return json({ error: error.message }, 500);
    }
    if (!codeId && !memberId) return json({ error: "nothing to revoke" }, 400);
    return json({ ok: true });
  }

  // ------------------------------------------------------------------ redeem
  if (action === "redeem") {
    if (membership && !membership.revoked_at) return json({ ok: true, already: true });

    const supplied = String(body.code ?? "");
    if (supplied.trim().length < 6) return json({ error: "enter your passcode" }, 400);

    // One locked step in the database: validate, grant and count the claim together, so two
    // devices cannot both spend the same passcode.
    const { data: outcome, error: redeemError } = await admin.rpc("consume_access_code", {
      p_code_hash: await hashOf(supplied),
      p_user_id: user.id,
    });
    if (redeemError) return json({ error: redeemError.message }, 500);

    const result = (outcome || {}) as { status?: string; label?: string; claimed_at?: string };
    if (result.status === "granted") return json({ ok: true, label: result.label });
    if (result.status === "spent") {
      return json({
        error: "That passcode has already been used on another device. Ask for a new one.",
        claimed_at: result.claimed_at ?? null,
      }, 403);
    }
    if (result.status === "expired") return json({ error: "That passcode has expired." }, 403);
    if (result.status === "revoked") return json({ error: "That passcode was cancelled." }, 403);
    return json({ error: "That passcode is not valid." }, 403);
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
