import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractTextMessages, pseudonym, verifyChallenge, verifySignature } from "./whatsapp";

const secret = "app-secret-value";
const sign = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

describe("verifyChallenge", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  it("echoes the challenge for the right token", () => {
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "verify-token-1", "hub.challenge": "1158201444" }), "verify-token-1")).toBe("1158201444");
  });
  it("rejects a wrong token, wrong mode or missing values", () => {
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }), "verify-token-1")).toBeNull();
    expect(verifyChallenge(q({ "hub.mode": "unsubscribe", "hub.verify_token": "verify-token-1", "hub.challenge": "1" }), "verify-token-1")).toBeNull();
    expect(verifyChallenge(q({ "hub.mode": "subscribe", "hub.verify_token": "verify-token-1" }), "verify-token-1")).toBeNull();
  });
});

describe("verifySignature", () => {
  const body = '{"entry":[{"changes":[]}]}';
  it("accepts a valid signature made with the app secret", () => {
    expect(verifySignature(body, sign(body), secret)).toBe(true);
  });
  it("rejects a signature made with a different key, such as the verify token", () => {
    expect(verifySignature(body, sign(body, "verify-token-1"), secret)).toBe(false);
  });
  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", sign(body), secret)).toBe(false);
  });
  it("rejects missing, malformed or wrong length headers without throwing", () => {
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "abc", secret)).toBe(false);
    expect(verifySignature(body, "sha256=", secret)).toBe(false);
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
  it("is byte exact: the raw text is signed, not a re serialised object", () => {
    const spaced = '{ "entry": [ { "changes": [] } ] }';
    expect(verifySignature(spaced, sign(JSON.stringify(JSON.parse(spaced))), secret)).toBe(false);
    expect(verifySignature(spaced, sign(spaced), secret)).toBe(true);
  });
});

describe("extractTextMessages", () => {
  const payload = (messages: unknown[]) => ({ entry: [{ changes: [{ value: { messages } }] }] });
  it("returns text messages and skips other types", () => {
    const found = extractTextMessages(
      payload([
        { id: "wamid.1", from: "15550001", type: "text", text: { body: "Where is my order?" } },
        { id: "wamid.2", from: "15550001", type: "image" },
      ]),
    );
    expect(found).toEqual([{ id: "wamid.1", from: "15550001", body: "Where is my order?" }]);
  });
  it("ignores status updates and garbage", () => {
    expect(extractTextMessages({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] })).toEqual([]);
    expect(extractTextMessages("nope")).toEqual([]);
    expect(extractTextMessages(null)).toEqual([]);
  });
  it("caps very long messages", () => {
    const long = "x".repeat(5000);
    expect(extractTextMessages(payload([{ id: "1", from: "2", type: "text", text: { body: long } }]))[0].body).toHaveLength(1000);
  });
});

describe("pseudonym", () => {
  it("is stable, salted and does not contain the input", () => {
    expect(pseudonym("15550001", "a")).toBe(pseudonym("15550001", "a"));
    expect(pseudonym("15550001", "a")).not.toBe(pseudonym("15550001", "b"));
    expect(pseudonym("15550001", "a")).not.toContain("15550001");
  });
});
