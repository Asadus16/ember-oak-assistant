// Timeout and retry for model calls. A customer must not wait 40 seconds because one request stalled, so a
// call that produces nothing within the timeout is aborted and tried again. Independent of the SDK so it can
// be tested with fakes.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} produced nothing within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export type RetryOptions = {
  // Total tries, including the first.
  attempts?: number;
  // Abort an attempt that has not produced a result (or, for streams, a first chunk) within this time.
  timeoutMs: number;
  baseDelayMs?: number;
  // The caller's own signal (the visitor closed the page). Never retried.
  signal?: AbortSignal;
  isTransient: (error: unknown) => boolean;
  // The server's own "retry in N ms" hint, when the error carries one.
  retryAfterMs?: (error: unknown) => number | undefined;
  // Longest wait we are willing to take for a server hint. A longer hint means "give up", so a customer is
  // told the service is busy instead of being left waiting.
  maxWaitMs?: number;
};

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited by the model provider, retry after ${retryAfterMs} ms`);
    this.name = "RateLimitedError";
  }
}

type Attempt = { signal: AbortSignal; timedOut: () => boolean; disarm: () => void; cleanup: () => void };

function startAttempt(options: RetryOptions): Attempt {
  const controller = new AbortController();
  let timedOut = false;
  const forward = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new TimeoutError("request", options.timeoutMs));
  }, options.timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    disarm: () => clearTimeout(timer),
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forward);
    },
  };
}

function shouldRetry(error: unknown, attempt: Attempt, index: number, options: RetryOptions): boolean {
  if (options.signal?.aborted) return false; // the visitor left
  if (index + 1 >= (options.attempts ?? 3)) return false;
  return attempt.timedOut() || options.isTransient(error);
}

// How long to wait before the next try: the server's hint if it gave one, otherwise exponential backoff.
// Throws RateLimitedError when the hint is longer than we are willing to wait.
function waitTime(error: unknown, index: number, options: RetryOptions): number {
  const hint = options.retryAfterMs?.(error);
  if (hint === undefined) return (options.baseDelayMs ?? 600) * 2 ** index;
  if (hint > (options.maxWaitMs ?? 5_000)) throw new RateLimitedError(hint);
  return hint;
}

// One request, one result.
export async function callWithRetry<T>(call: (signal: AbortSignal) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let index = 0; ; index++) {
    const attempt = startAttempt(options);
    let wait: number;
    try {
      return await call(attempt.signal);
    } catch (error) {
      if (!shouldRetry(error, attempt, index, options)) throw attempt.timedOut() ? new TimeoutError("request", options.timeoutMs) : error;
      wait = waitTime(error, index, options);
    } finally {
      attempt.cleanup();
    }
    await sleep(wait);
  }
}

// A stream. Only failures BEFORE the first chunk are retried: once part of an answer has been passed on,
// starting again would show the customer a second, different answer.
export async function* streamWithRetry<T>(
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  options: RetryOptions,
): AsyncGenerator<T> {
  for (let index = 0; ; index++) {
    const attempt = startAttempt(options);
    let started = false;
    let wait: number;
    try {
      const stream = await open(attempt.signal);
      for await (const chunk of stream) {
        if (!started) {
          started = true;
          attempt.disarm(); // the stall timer only guards the wait for the first chunk
        }
        yield chunk;
      }
      return;
    } catch (error) {
      if (started || !shouldRetry(error, attempt, index, options)) {
        throw attempt.timedOut() && !started ? new TimeoutError("stream", options.timeoutMs) : error;
      }
      wait = waitTime(error, index, options);
    } finally {
      attempt.cleanup();
    }
    await sleep(wait);
  }
}
