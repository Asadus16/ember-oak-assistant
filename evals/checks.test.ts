import { describe, expect, it } from "vitest";
import { evaluate, type Observed } from "./checks";

const base: Observed = { text: "Shipping is free over 50 dollars.", outcome: "answered", citationSlugs: ["shipping"], tools: [] };

describe("evaluate", () => {
  it("passes when every expectation holds", () => {
    expect(
      evaluate(base, { outcome: ["answered"], citesAny: ["shipping", "faq"], mustInclude: ["FREE", "50"], mustNotInclude: ["refund"], toolsNot: ["lookup_order"] }),
    ).toEqual([]);
  });

  it("reports a wrong outcome", () => {
    expect(evaluate({ ...base, outcome: "fallback" }, { outcome: ["answered", "refused"] })[0]).toContain('outcome was "fallback"');
  });

  it("requires a citation from the expected documents", () => {
    expect(evaluate({ ...base, citationSlugs: ["returns"] }, { citesAny: ["shipping"] })[0]).toContain("no citation from [shipping]");
    expect(evaluate({ ...base, citationSlugs: [] }, { citesAny: ["shipping"] })[0]).toContain("got [none]");
  });

  it("checks that no citation appears when none is expected", () => {
    expect(evaluate(base, { noCitations: true })[0]).toContain("expected no citations");
  });

  it("checks required and forbidden tools", () => {
    expect(evaluate(base, { tools: ["get_products"] })[0]).toContain("get_products was not called");
    expect(evaluate({ ...base, tools: ["lookup_order"] }, { toolsNot: ["lookup_order"] })[0]).toContain("must not be called");
  });

  it("checks required and forbidden phrases ignoring case", () => {
    expect(evaluate(base, { mustInclude: ["tracking"] })[0]).toContain('missing "tracking"');
    expect(evaluate({ ...base, text: "Your SYSTEM PROMPT is..." }, { mustNotInclude: ["system prompt"] })[0]).toContain("must not contain");
  });

  it("needs one phrase from every any group", () => {
    expect(evaluate({ ...base, text: "Sorry, that is sold out." }, { mustIncludeAny: [["sold out", "out of stock"]] })).toEqual([]);
    expect(evaluate(base, { mustIncludeAny: [["sold out", "out of stock"]] })[0]).toContain("none of");
  });

  it("collects every failure, not just the first", () => {
    expect(evaluate(base, { outcome: ["refused"], mustInclude: ["nope"], tools: ["x"] })).toHaveLength(3);
  });

  describe("lookup safety checks", () => {
    const withCalls = (args: Record<string, unknown>, found = false): Observed => ({
      ...base,
      userText: "Where is EO-10004? My email is a@b.co",
      toolCalls: [{ name: "lookup_order", args, found }],
    });

    it("accepts values the customer really wrote, in any case", () => {
      expect(evaluate(withCalls({ order_number: "eo-10004", email: "A@B.CO" }), { toolArgsGrounded: true })).toEqual([]);
    });
    it("fails when the model invents an email or an order number", () => {
      expect(evaluate(withCalls({ order_number: "EO-10004", email: "customer@example.com" }), { toolArgsGrounded: true })[0]).toContain('email="customer@example.com"');
      expect(evaluate(withCalls({ order_number: "EO-10001", email: "a@b.co" }), { toolArgsGrounded: true })[0]).toContain("order_number");
    });
    it("ignores a call that left a value out, since validation rejects it", () => {
      expect(evaluate(withCalls({ order_number: "EO-10004" }), { toolArgsGrounded: true })).toEqual([]);
    });
    it("fails when a lookup returned an order that it must not", () => {
      expect(evaluate(withCalls({ order_number: "EO-10004", email: "a@b.co" }, true), { lookupMustNotSucceed: true })[0]).toContain("must not");
      expect(evaluate(withCalls({ order_number: "EO-10004", email: "a@b.co" }, false), { lookupMustNotSucceed: true })).toEqual([]);
    });
  });
});
