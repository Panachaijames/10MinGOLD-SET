// Delivery receipts posted by the service worker (no user session available there).
// The per-delivery receipt token, stored only as a SHA-256 hash, is the proof.
import { adminClient, corsHeaders } from "../_shared/db.ts";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const headers = corsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers });

  let body: { deliveryId?: string; receiptToken?: string; receivedAt?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400, headers });
  }
  const { deliveryId, receiptToken, receivedAt } = body;
  if (!deliveryId || !receiptToken || receiptToken.length < 16) {
    return Response.json({ error: "deliveryId and receiptToken are required" }, { status: 422, headers });
  }
  const received = receivedAt && !Number.isNaN(Date.parse(receivedAt)) ? new Date(receivedAt) : new Date();
  const serverReceived = new Date();

  const client = adminClient();
  const { data, error } = await client
    .from("push_deliveries")
    .update({ status: "received", received_at: serverReceived.toISOString() })
    .eq("id", deliveryId)
    .eq("receipt_token_hash", await sha256Hex(receiptToken))
    .select("id");
  if (error) return Response.json({ error: error.message }, { status: 500, headers });
  if (!data?.length) return Response.json({ error: "unknown delivery receipt" }, { status: 404, headers });
  return Response.json(
    { ok: true, client_received_at: received.toISOString(), server_received_at: serverReceived.toISOString() },
    { headers },
  );
});
