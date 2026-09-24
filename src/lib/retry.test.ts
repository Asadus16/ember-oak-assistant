import { describe, expect, it, vi } from "vitest";
import { callWithRetry, RateLimitedError, streamWithRetry, TimeoutError } from "./retry";

const transient = (e: unknown) => e instanceof Error && /fetch failed|503/.test(e.message);
const fast = { timeoutMs: 40, baseDelayMs: 1, isTransient: transient };

// Never settles until aborted, like a request that stalls.
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted"))));

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("callWithRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const call = vi.fn(async () => "ok");
    expect(await callWithRetry(call, fast)).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error and then succeeds", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce("ok");
    expect(await callWithRetry(call, fast)).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled attempt and retries it", async () => {
    let n = 0;
    const call = vi.fn((signal: AbortSignal) => (++n === 1 ? hang(signal) : Promise.resolve("recovered")));
    expect(await callWithRetry(call, fast)).toBe("recovered");
    expect(n).toBe(2);
  });

  it("gives up after the attempt limit and reports a timeout", async () => {
    const call = vi.fn((signal: AbortSignal) => hang(signal));
    await expect(callWithRetry(call, { ...fast, attempts: 2 })).rejects.toBeInstanceOf(TimeoutError);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error that is not transient", async () => {
    const call = vi.fn().mockRejectedValue(new Error("400 bad request"));
    await expect(callWithRetry(call, fast)).rejects.toThrow("400 bad request");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the visitor already left", async () => {
    const controller = new AbortController();
    const call = vi.fn(async () => {
      controller.abort();
      throw new Error("fetch failed");
    });
    await expect(callWithRetry(call, { ...fast, signal: controller.signal })).rejects.toThrow("fetch failed");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("streamWithRetry", () => {
  it("streams every chunk from a healthy stream", async () => {
    const open = async () =>
      (async function* () {
        yield 1;
        yield 2;
      })();
    expect(await collect(streamWithRetry(open, fast))).toEqual([1, 2]);
  });

  it("retries when the stream stalls before its first chunk", async () => {
    let n = 0;
    const open = vi.fn(async (signal: AbortSignal) => {
      if (++n === 1) return hang(signal) as Promise<AsyncIterable<number>>;
      return (async function* () {
        yield 7;
      })();
    });
    expect(await collect(streamWithRetry(open, fast))).toEqual([7]);
    expect(n).toBe(2);
  });

  it("retries a network error that happens before the first chunk", async () => {
    let n = 0;
    const open = vi.fn(async () => {
      if (++n === 1) throw new Error("fetch failed");
      return (async function* () {
        yield "answer";
      })();
    });
    expect(await collect(streamWithRetry(open, fast))).toEqual(["answer"]);
  });

  it("never restarts after part of the answer was already delivered", async () => {
    const open = vi.fn(async () =>
      (async function* () {
        yield "partial ";
        throw new Error("fetch failed");
      })(),
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const c of streamWithRetry(open, fast)) seen.push(c);
      })(),
    ).rejects.toThrow("fetch failed");
    expect(seen).toEqual(["partial "]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not time out a slow stream once it has started", async () => {
    const open = async () =>
      (async function* () {
        yield "a";
        await new Promise((r) => setTimeout(r, 120)); // longer than timeoutMs, but the first chunk already arrived
        yield "b";
      })();
    expect(await collect(streamWithRetry(open, fast))).toEqual(["a", "b"]);
  });
});

describe("server retry hints", () => {
  const limited = new Error("429 quota exceeded, retry in 30 ms");
  const withHint = { timeoutMs: 1000, baseDelayMs: 1, isTransient: (e: unknown) => e === limited, retryAfterMs: (e: unknown) => (e === limited ? 30 : undefined) };

  it("waits for the server's delay and then retries", async () => {
    const call = vi.fn().mockRejectedValueOnce(limited).mockResolvedValueOnce("ok");
    const started = Date.now();
    expect(await callWithRetry(call, { ...withHint, maxWaitMs: 200 })).toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("gives up with RateLimitedError when the hint is longer than the allowed wait", async () => {
    const call = vi.fn().mockRejectedValue(limited);
    await expect(callWithRetry(call, { ...withHint, maxWaitMs: 10 })).rejects.toBeInstanceOf(RateLimitedError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("applies to streams that fail before their first chunk", async () => {
    let n = 0;
    const open = vi.fn(async () => {
      if (++n === 1) throw limited;
      return (async function* () {
        yield "done";
      })();
    });
    expect(await collect(streamWithRetry(open, { ...withHint, maxWaitMs: 200 }))).toEqual(["done"]);
    const never = vi.fn(async () => {
      throw limited;
    });
    await expect(collect(streamWithRetry(never, { ...withHint, maxWaitMs: 10 }))).rejects.toBeInstanceOf(RateLimitedError);
  });
});
