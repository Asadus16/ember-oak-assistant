import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// WhatsApp Cloud API adapter (official Meta API). Pure functions, so they can be tested without Meta.

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// GET verification handshake. Returns the challenge to echo, or null when the request must be rejected.
export function verifyChallenge(params: URLSearchParams, verifyToken: string): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (!token || !challenge || !safeEqual(token, verifyToken)) return null;
  return challenge;
}

// POST signature: X-Hub-Signature-256 is "sha256=" + HMAC-SHA256 of the RAW request body, keyed with the
// APP SECRET (not the verify token). The raw text must be used, never a re serialised JSON object.
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(header.slice("sha256=".length), expected);
}

const payloadSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string(),
                      type: z.string(),
                      text: z.object({ body: z.string() }).optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type IncomingText = { id: string; from: string; body: string };

// Plain text messages only. Status updates, images and other types are ignored.
export function extractTextMessages(payload: unknown): IncomingText[] {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const found: IncomingText[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const m of change.value.messages ?? []) {
        if (m.type === "text" && m.text?.body) found.push({ id: m.id, from: m.from, body: m.text.body.slice(0, 1000) });
      }
    }
  }
  return found;
}

// Pseudonymous id for rate limits and conversation lookup, so the phone number is not stored as an id.
export function pseudonym(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

export type WhatsAppConfig = { accessToken: string; phoneNumberId: string; graphVersion: string };

export async function sendText(config: WhatsAppConfig, to: string, body: string): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4096) } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`WhatsApp send failed with status ${response.status}`);
}
