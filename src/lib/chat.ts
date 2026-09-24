import type { Content, Part } from "@google/genai";
import type { Db } from "./db";
import type { Llm } from "./gemini";
import { checkAnswer, formatSources, redactPii, wrapUntrusted, type Citation, type Outcome } from "./guard";
import { BUSY_TEXT, RATE_LIMITED_TEXT, SYSTEM_PROMPT } from "./prompt";
import { RateLimitedError } from "./retry";
import { runTool, TOOL_DECLARATIONS } from "./tools";

// Observes every tool call with its arguments and result. For evals and tests only: the arguments can hold an
// email address, so this is never forwarded to the browser.
export type ToolTrace = (call: { name: string; args: unknown; result: Record<string, unknown> }) => void;

export type ChatDeps = { db: Db; llm: Llm; trace?: ToolTrace };

export type ChatRequest = {
  message: string;
  channel: "web" | "whatsapp";
  conversationId?: string;
  externalId?: string;
  // Stable pseudonymous key for rate limits (a hashed IP or a hashed phone number).
  clientKey: string;
  signal?: AbortSignal;
};

export type ChatEvent =
  | { type: "meta"; conversationId: string }
  | { type: "token"; text: string }
  | { type: "tool"; name: string }
  // `done.text` is authoritative: the client replaces what it streamed with it, because the guard may
  // have removed invalid citation markers or replaced an unsupported answer.
  | { type: "done"; text: string; citations: Citation[]; outcome: Outcome | "rate_limited" | "error" };

// Hard limits. Every loop in an agent needs one.
export const LIMITS = {
  maxSteps: 3,
  maxToolCallsPerStep: 2,
  historyMessages: 6,
  retrievalResults: 5,
  chatPerMinute: 20,
} as const;

const ERROR_TEXT = "Sorry, something went wrong on our side. Please try again in a moment.";

type Call = { name: string; args: Record<string, unknown> };

export async function* handleMessage(deps: ChatDeps, req: ChatRequest): AsyncGenerator<ChatEvent> {
  const { db, llm, trace } = deps;
  const started = Date.now();

  const conversationId = await db.getOrCreateConversation(req.channel, req.externalId, req.conversationId);
  yield { type: "meta", conversationId };

  const history = await db.recentMessages(conversationId, LIMITS.historyMessages);
  await db.saveMessage({ conversationId, role: "user", content: redactPii(req.message, { emails: false }) });

  if (!(await db.hitRateLimit(`chat:${req.clientKey}`, LIMITS.chatPerMinute, 60))) {
    await db.saveMessage({ conversationId, role: "assistant", content: RATE_LIMITED_TEXT, outcome: "rate_limited" });
    yield { type: "done", text: RATE_LIMITED_TEXT, citations: [], outcome: "rate_limited" };
    return;
  }

  try {
    // Retrieval. The previous customer message is included so a follow up like "and how long does it take?"
    // still finds the right documents.
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    const queryText = `${lastUser} ${req.message}`.trim().slice(0, 500);
    const [embedding] = await llm.embed([queryText]);
    const sources = await db.hybridSearch(queryText, embedding, LIMITS.retrievalResults);

    const contents: Content[] = history.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));
    contents.push({
      role: "user",
      parts: [
        {
          text: `${wrapUntrusted("the STORE SOURCES (store documents)", formatSources(sources))}\n\nCustomer message: ${req.message}`,
        },
      ],
    });

    const toolsUsed: string[] = [];
    let finalText = "";

    for (let step = 0; step < LIMITS.maxSteps; step++) {
      let stepText = "";
      const calls: Call[] = [];
      const modelParts: Part[] = [];

      for await (const chunk of llm.stream({ system: SYSTEM_PROMPT, contents, tools: TOOL_DECLARATIONS, signal: req.signal })) {
        if (chunk.text) {
          stepText += chunk.text;
          yield { type: "token", text: chunk.text };
        }
        if (chunk.functionCalls) calls.push(...chunk.functionCalls);
        if (chunk.parts) modelParts.push(...chunk.parts);
      }

      if (calls.length === 0) {
        finalText = stepText;
        break;
      }

      // Send the model turn back exactly as received (this keeps any thought signatures intact), then answer
      // every function call. Calls beyond the per step limit get an error instead of being executed.
      contents.push({ role: "model", parts: modelParts });
      const responses: Part[] = [];
      for (const [index, call] of calls.entries()) {
        let result: Record<string, unknown>;
        if (index >= LIMITS.maxToolCallsPerStep) {
          result = { error: "too_many_tool_calls_in_one_step" };
        } else {
          yield { type: "tool", name: call.name };
          toolsUsed.push(call.name);
          result = await runTool(call.name, call.args, { db, clientKey: req.clientKey });
          trace?.({ name: call.name, args: call.args, result });
        }
        responses.push({
          functionResponse: {
            name: call.name,
            response: { output: wrapUntrusted(`the result of the ${call.name} tool`, JSON.stringify(result)) },
          },
        });
      }
      contents.push({ role: "user", parts: responses });
    }

    const checked = checkAnswer(finalText, sources, toolsUsed);
    await db.saveMessage({
      conversationId,
      role: "assistant",
      content: checked.text,
      citations: checked.citations,
      tools: toolsUsed,
      outcome: checked.outcome,
      model: llm.model,
      latencyMs: Date.now() - started,
    });
    yield { type: "done", text: checked.text, citations: checked.citations, outcome: checked.outcome };
  } catch (error) {
    // The visitor closed the page: nothing to report.
    if (req.signal?.aborted) return;
    // Log the cause on the server only. The visitor gets a generic message, never an internal error.
    // A provider rate limit is not a bug: say the service is busy, not "something went wrong".
    const busy = error instanceof RateLimitedError;
    const text = busy ? BUSY_TEXT : ERROR_TEXT;
    console.error("chat_error", { conversationId, busy, message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    await db.saveMessage({ conversationId, role: "assistant", content: text, outcome: "error", latencyMs: Date.now() - started });
    yield { type: "done", text, citations: [], outcome: "error" };
  }
}

// Runs the whole exchange and returns the final answer. Used by the WhatsApp adapter, which cannot stream.
export async function answerOnce(deps: ChatDeps, req: ChatRequest): Promise<{ text: string; citations: Citation[]; outcome: string }> {
  let last: { text: string; citations: Citation[]; outcome: string } = { text: ERROR_TEXT, citations: [], outcome: "error" };
  for await (const event of handleMessage(deps, req)) {
    if (event.type === "done") last = { text: event.text, citations: event.citations, outcome: event.outcome };
  }
  return last;
}
