import "server-only";
import { GoogleGenAI, ThinkingLevel, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { EMBEDDING_DIMENSIONS, getEnv } from "./env";
import { callWithRetry, streamWithRetry } from "./retry";

// The chat core depends on this small interface, not on the SDK, so it can be tested without the network.
export type LlmRequest = {
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
  signal?: AbortSignal;
};

export type LlmChunk = {
  text?: string;
  functionCalls?: { name: string; args: Record<string, unknown> }[];
  parts?: Part[];
};

export type Llm = {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
  stream(request: LlmRequest): AsyncGenerator<LlmChunk>;
};

// Measured on 2026-09-25: a healthy call answers in about 1 to 1.5 s, but roughly one call in six stalled for
// 40 s or more. A stalled request is aborted and tried again instead of making the customer wait.
const FIRST_CHUNK_TIMEOUT_MS = 15_000;
const EMBED_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : undefined;
}

function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return /fetch failed|network|econnreset|etimedout|socket|und_err/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
}

// The provider reports how long to wait, for example "Please retry in 37.08s" or "retryDelay": "37s".
export function retryAfterMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /retry in ([\d.]+)s/i.exec(message) ?? /retryDelay\\*"?\s*:\s*\\*"(\d+(?:\.\d+)?)s/i.exec(message);
  return match ? Math.ceil(Number(match[1]) * 1000) + 500 : undefined;
}

export function createGemini(): Llm {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Create a free key at https://aistudio.google.com/apikey and add it to .env.local.");
  }
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  return {
    model: env.GEMINI_MODEL,

    async embed(texts) {
      if (texts.length === 0) return [];
      // Each text is its own Content object. In the official cookbook a plain list of parts is combined
      // into ONE embedding for gemini-embedding-2, while a list of Content objects returns one each.
      const response = await callWithRetry(
        (signal) =>
          ai.models.embedContent({
            model: env.GEMINI_EMBEDDING_MODEL,
            contents: texts.map((text) => ({ parts: [{ text }] })),
            config: { outputDimensionality: EMBEDDING_DIMENSIONS, abortSignal: signal },
          }),
        { timeoutMs: EMBED_TIMEOUT_MS, isTransient, retryAfterMs, maxWaitMs: env.GEMINI_MAX_RETRY_WAIT_MS },
      );
      const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(
          `Embedding response mismatch: expected ${texts.length} vectors of ${EMBEDDING_DIMENSIONS}, got ${vectors.length} (${vectors[0]?.length ?? 0}).`,
        );
      }
      return vectors;
    },

    async *stream(request) {
      const chunks = streamWithRetry(
        (signal) =>
          ai.models.generateContentStream({
            model: env.GEMINI_MODEL,
            contents: request.contents,
            config: {
              systemInstruction: request.system,
              temperature: 0.2,
              thinkingConfig: { thinkingLevel: ThinkingLevel[env.GEMINI_THINKING_LEVEL] },
              tools: request.tools.length > 0 ? [{ functionDeclarations: request.tools }] : undefined,
              // We run the tool loop ourselves so every call is validated, limited and logged.
              automaticFunctionCalling: { disable: true },
              abortSignal: signal,
            },
          }),
        { timeoutMs: FIRST_CHUNK_TIMEOUT_MS, signal: request.signal, isTransient, retryAfterMs, maxWaitMs: env.GEMINI_MAX_RETRY_WAIT_MS },
      );

      for await (const chunk of chunks) {
        // Read the parts directly. The SDK's chunk.text getter prints a warning whenever a chunk holds a
        // function call, and reasoning ("thought") parts must never reach the customer.
        const parts = chunk.candidates?.[0]?.content?.parts;
        const text = parts
          ?.filter((p) => typeof p.text === "string" && !p.thought)
          .map((p) => p.text)
          .join("");
        const calls = parts
          ?.filter((p) => p.functionCall)
          .map((p) => ({ name: p.functionCall?.name ?? "", args: (p.functionCall?.args ?? {}) as Record<string, unknown> }));
        yield { text: text || undefined, functionCalls: calls && calls.length > 0 ? calls : undefined, parts };
      }
    },
  };
}
