import { describe, expect, it } from "vitest";
import { parseSseBuffer } from "./sse";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("parseSseBuffer", () => {
  it("parses several events from one chunk", () => {
    const { events, rest } = parseSseBuffer(frame({ a: 1 }) + frame({ b: 2 }));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe("");
  });

  it("keeps an incomplete event as the rest until the next chunk completes it", () => {
    const whole = frame({ type: "token", text: "hello" });
    const first = parseSseBuffer(whole.slice(0, 12));
    expect(first.events).toEqual([]);
    const second = parseSseBuffer(first.rest + whole.slice(12));
    expect(second.events).toEqual([{ type: "token", text: "hello" }]);
    expect(second.rest).toBe("");
  });

  it("handles a chunk boundary inside the blank line separator", () => {
    const a = parseSseBuffer('data: {"x":1}\n');
    expect(a.events).toEqual([]);
    const b = parseSseBuffer(a.rest + "\ndata: {\"y\":2}\n\n");
    expect(b.events).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("ignores comment lines and blocks without data", () => {
    expect(parseSseBuffer(": keep-alive\n\n" + frame({ ok: true })).events).toEqual([{ ok: true }]);
  });

  it("skips malformed JSON without losing later events", () => {
    const { events } = parseSseBuffer("data: {not json}\n\n" + frame({ ok: true }));
    expect(events).toEqual([{ ok: true }]);
  });

  it("accepts CRLF line endings", () => {
    expect(parseSseBuffer('data: {"a":1}\r\n\r\n').events).toEqual([{ a: 1 }]);
  });

  it("keeps text with newlines and unicode intact", () => {
    const text = "Line one\nLine two ☕";
    expect(parseSseBuffer(frame({ text })).events).toEqual([{ text }]);
  });
});
