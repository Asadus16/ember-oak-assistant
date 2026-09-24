import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Llm, LlmChunk } from "../src/lib/gemini";

// Record and replay of model calls, so evals run fast, free and deterministic in CI:
//   live    calls the real model, records nothing
//   record  calls the real model and stores every response in evals/recordings
//   replay  serves stored responses only and never touches the network (fails if a call was not recorded)
export type CacheMode = "live" | "record" | "replay";

const DIR = path.join(process.cwd(), "evals", "recordings");

// The prompt contains a random boundary id per call. It is normalised so the same conversation always
// produces the same key.
export function normalize(value: unknown): string {
  return JSON.stringify(value).replace(/untrusted-data-[0-9a-f-]{36}/g, "untrusted-data-X");
}

export function keyOf(kind: "embed" | "stream", model: string, payload: unknown): string {
  return createHash("sha256").update(`${kind}\n${model}\n${normalize(payload)}`).digest("hex").slice(0, 40);
}

// Used in replay mode when there is no API key: any call that is not recorded is an error.
export function offlineLlm(model: string): Llm {
  return {
    model,
    async embed() {
      throw new Error("No model configured (offline replay).");
    },
    async *stream() {
      throw new Error("No model configured (offline replay).");
    },
  };
}

export function withRecording(llm: Llm, mode: CacheMode, embeddingModel: string, dir: string = DIR): Llm {
  if (mode === "live") return llm;

  const file = (key: string) => path.join(dir, `${key}.json`);
  const load = <T>(key: string): T | undefined => (existsSync(file(key)) ? (JSON.parse(readFileSync(file(key), "utf8")) as T) : undefined);
  const save = (key: string, data: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(key), JSON.stringify(data));
  };
  const missing = (kind: string, key: string) =>
    new Error(`No recording for ${kind} ${key}. Run the evals once with EVAL_MODE=record and a real API key.`);

  return {
    model: llm.model,

    async embed(texts) {
      const key = keyOf("embed", embeddingModel, texts);
      const hit = load<number[][]>(key);
      if (hit) return hit;
      if (mode === "replay") throw missing("embed", key);
      const vectors = await llm.embed(texts);
      save(key, vectors);
      return vectors;
    },

    async *stream(request) {
      const key = keyOf("stream", llm.model, { system: request.system, contents: request.contents, tools: request.tools });
      const hit = load<LlmChunk[]>(key);
      if (hit) {
        for (const chunk of hit) yield chunk;
        return;
      }
      if (mode === "replay") throw missing("stream", key);
      const chunks: LlmChunk[] = [];
      for await (const chunk of llm.stream(request)) {
        chunks.push(chunk);
        yield chunk;
      }
      save(key, chunks);
    },
  };
}
