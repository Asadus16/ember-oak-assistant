import { describe, expect, it } from "vitest";
import { retryAfterMs } from "./gemini";

describe("retryAfterMs", () => {
  it("reads the human readable hint and adds a small margin", () => {
    expect(retryAfterMs(new Error("You exceeded your quota. Please retry in 37.088757659s."))).toBe(37589);
  });
  it("reads the structured retryDelay field, also when it is JSON escaped", () => {
    expect(retryAfterMs(new Error('{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}'))).toBe(37500);
    expect(retryAfterMs(new Error('{\\"retryDelay\\": \\"12s\\"}'))).toBe(12500);
  });
  it("returns undefined when there is no hint", () => {
    expect(retryAfterMs(new Error("fetch failed"))).toBeUndefined();
  });
});
