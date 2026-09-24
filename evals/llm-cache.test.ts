import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Llm, LlmChunk, LlmRequest } from "../src/lib/gemini";
import { keyOf, normalize, offlineLlm, withRecording } from "./llm-cache";

function countingLlm() {
  const calls = { embed: 0, stream: 0 };
  const llm: Llm = {
    model: "m1",
    async embed(texts) {
      calls.embed++;
      return texts.map((_, i) => [i + 0.5]);
    },
    async *stream() {
      calls.stream++;
      yield { text: "hello " } as LlmChunk;
      yield { text: "world" } as LlmChunk;
    },
  };
  return { llm, calls };
}

const request = (id: string): LlmRequest => ({
  system: "rules",
  contents: [{ role: "user", parts: [{ text: `<untrusted-data-${id}>data</untrusted-data-${id}> question` }] }],
  tools: [],
});
const collect = async (llm: Llm, r: LlmRequest) => {
  const out: LlmChunk[] = [];
  for await (const c of llm.stream(r)) out.push(c);
  return out;
};

describe("normalize and keyOf", () => {
  it("ignores the random untrusted boundary id", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(normalize(request(a))).toBe(normalize(request(b)));
    expect(keyOf("stream", "m", request(a))).toBe(keyOf("stream", "m", request(b)));
  });
  it("still separates different questions, models and kinds", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const other = { ...request(id), system: "other rules" };
    expect(keyOf("stream", "m", request(id))).not.toBe(keyOf("stream", "m", other));
    expect(keyOf("stream", "m1", request(id))).not.toBe(keyOf("stream", "m2", request(id)));
    expect(keyOf("stream", "m", ["a"])).not.toBe(keyOf("embed", "m", ["a"]));
  });
});

describe("withRecording", () => {
  it("records in record mode and replays without touching the model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const live = countingLlm();
    const recorder = withRecording(live.llm, "record", "emb", dir);
    const first = await collect(recorder, request("11111111-1111-4111-8111-111111111111"));
    const vectors = await recorder.embed(["a", "b"]);
    expect(live.calls).toEqual({ embed: 1, stream: 1 });

    const offline = withRecording(offlineLlm("m1"), "replay", "emb", dir);
    // Different random boundary id, same conversation: must hit the same recording.
    const replayed = await collect(offline, request("33333333-3333-4333-8333-333333333333"));
    expect(replayed).toEqual(first);
    expect(await offline.embed(["a", "b"])).toEqual(vectors);
  });

  it("fails clearly in replay mode when a call was never recorded", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const offline = withRecording(offlineLlm("m1"), "replay", "emb", dir);
    await expect(offline.embed(["never seen"])).rejects.toThrow(/No recording for embed/);
    await expect(collect(offline, request("11111111-1111-4111-8111-111111111111"))).rejects.toThrow(/No recording for stream/);
  });

  it("does not record or cache anything in live mode", async () => {
    const live = countingLlm();
    const llm = withRecording(live.llm, "live", "emb");
    await llm.embed(["x"]);
    await llm.embed(["x"]);
    expect(live.calls.embed).toBe(2);
  });

  it("uses a stored recording instead of calling the model again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const live = countingLlm();
    const recorder = withRecording(live.llm, "record", "emb", dir);
    await recorder.embed(["same"]);
    const spy = vi.spyOn(live.llm, "embed");
    await recorder.embed(["same"]);
    expect(spy).not.toHaveBeenCalled();
  });
});
