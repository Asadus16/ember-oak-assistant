import { after } from "next/server";
import { answerOnce } from "@/lib/chat";
import { getEnv } from "@/lib/env";
import { stripMarkers } from "@/lib/markers";
import { getDeps } from "@/lib/services";
import { extractTextMessages, pseudonym, sendText, verifyChallenge, verifySignature } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notConfigured = () => Response.json({ error: "whatsapp_not_configured" }, { status: 503 });

// Meta calls this once when the webhook is set up.
export async function GET(request: Request) {
  const { WHATSAPP_VERIFY_TOKEN } = getEnv();
  if (!WHATSAPP_VERIFY_TOKEN) return notConfigured();
  const challenge = verifyChallenge(new URL(request.url).searchParams, WHATSAPP_VERIFY_TOKEN);
  return challenge === null ? new Response("Forbidden", { status: 403 }) : new Response(challenge, { status: 200 });
}

export async function POST(request: Request) {
  const env = getEnv();
  if (!env.WHATSAPP_APP_SECRET) return notConfigured();

  // The signature covers the exact bytes Meta sent, so read the raw text before parsing anything.
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const messages = extractTextMessages(payload);

  // Meta expects a fast 200 and retries otherwise, so answer after the response is sent.
  after(async () => {
    const deps = getDeps();
    for (const message of messages) {
      try {
        // Meta retries deliveries: handle each message id once.
        if (!(await deps.db.hitRateLimit(`wamid:${message.id}`, 1, 86_400))) continue;

        const who = pseudonym(message.from, "wa");
        const reply = await answerOnce(deps, { message: message.body, channel: "whatsapp", externalId: who, clientKey: who });

        const plain = stripMarkers(reply.text);
        const titles = [...new Set(reply.citations.map((c) => c.title))];
        const text = titles.length > 0 ? `${plain}\n\nSources: ${titles.join(", ")}` : plain;

        if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_GRAPH_VERSION) {
          await sendText(
            { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, graphVersion: env.WHATSAPP_GRAPH_VERSION },
            message.from,
            text,
          );
        } else {
          console.warn("whatsapp_reply_skipped_not_configured", { messageId: message.id });
        }
      } catch (error) {
        console.error("whatsapp_message_error", { messageId: message.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  return Response.json({ ok: true });
}
