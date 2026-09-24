import { handleMessage, type ChatEvent } from "@/lib/chat";
import { chatInputSchema } from "@/lib/guard";
import { clientKey, getDeps } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_000;

const json = (body: unknown, status: number) => Response.json(body, { status });

export async function POST(request: Request) {
  // This endpoint spends model quota, so only the store's own pages may call it from a browser.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host")) return json({ error: "forbidden" }, 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);

  let input;
  try {
    input = chatInputSchema.parse(JSON.parse(raw));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  let deps;
  try {
    deps = getDeps();
  } catch (error) {
    // Missing configuration (for example no model key). Log the cause on the server, tell the visitor nothing internal.
    console.error("chat_unavailable", error instanceof Error ? error.message : String(error));
    return json({ error: "assistant_unavailable" }, 503);
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ChatEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const event of handleMessage(deps, {
          message: input.message,
          conversationId: input.conversationId,
          channel: "web",
          clientKey: clientKey(request),
          signal: request.signal,
        })) {
          send(event);
        }
      } catch (error) {
        console.error("chat_route_error", error instanceof Error ? error.message : String(error));
        send({ type: "done", text: "Sorry, something went wrong on our side. Please try again in a moment.", citations: [], outcome: "error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Stops reverse proxies (nginx) from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
