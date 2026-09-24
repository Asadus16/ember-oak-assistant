// Pure checks for one eval case. Deterministic string and set checks, no model judging, so a failure
// always points at a concrete difference.

export type Expect = {
  // Accepted outcomes. Omit to accept any.
  outcome?: string[];
  // At least one citation must come from one of these document slugs.
  citesAny?: string[];
  // The answer must carry no citations at all.
  noCitations?: boolean;
  // Tools that must / must not be called.
  tools?: string[];
  toolsNot?: string[];
  // Case insensitive substrings.
  mustInclude?: string[];
  // Every inner group needs at least one of its phrases present.
  mustIncludeAny?: string[][];
  mustNotInclude?: string[];
  // Every value passed to lookup_order (order number, email) must appear in what the customer wrote. The
  // model must never invent one.
  toolArgsGrounded?: boolean;
  // No lookup_order call may return an order.
  lookupMustNotSucceed?: boolean;
};

export type ToolCall = { name: string; args: Record<string, unknown>; found?: boolean };

export type Observed = {
  text: string;
  outcome: string;
  citationSlugs: string[];
  tools: string[];
  toolCalls?: ToolCall[];
  // Everything the customer wrote in the conversation.
  userText?: string;
};

export function evaluate(observed: Observed, expect: Expect): string[] {
  const failures: string[] = [];
  const text = observed.text.toLowerCase();

  if (expect.outcome && !expect.outcome.includes(observed.outcome)) {
    failures.push(`outcome was "${observed.outcome}", expected one of ${expect.outcome.join(", ")}`);
  }
  if (expect.citesAny && !observed.citationSlugs.some((s) => expect.citesAny!.includes(s))) {
    failures.push(`no citation from [${expect.citesAny.join(", ")}], got [${observed.citationSlugs.join(", ") || "none"}]`);
  }
  if (expect.noCitations && observed.citationSlugs.length > 0) {
    failures.push(`expected no citations, got [${observed.citationSlugs.join(", ")}]`);
  }
  for (const tool of expect.tools ?? []) {
    if (!observed.tools.includes(tool)) failures.push(`tool ${tool} was not called`);
  }
  for (const tool of expect.toolsNot ?? []) {
    if (observed.tools.includes(tool)) failures.push(`tool ${tool} must not be called`);
  }
  for (const phrase of expect.mustInclude ?? []) {
    if (!text.includes(phrase.toLowerCase())) failures.push(`answer is missing "${phrase}"`);
  }
  for (const group of expect.mustIncludeAny ?? []) {
    if (!group.some((phrase) => text.includes(phrase.toLowerCase()))) failures.push(`answer has none of [${group.join(" | ")}]`);
  }
  for (const phrase of expect.mustNotInclude ?? []) {
    if (text.includes(phrase.toLowerCase())) failures.push(`answer must not contain "${phrase}"`);
  }

  const calls = (observed.toolCalls ?? []).filter((c) => c.name === "lookup_order");
  if (expect.toolArgsGrounded) {
    const said = (observed.userText ?? "").toLowerCase();
    for (const call of calls) {
      for (const key of ["order_number", "email"]) {
        const value = call.args[key];
        if (typeof value === "string" && value.length > 0 && !said.includes(value.toLowerCase())) {
          failures.push(`lookup_order was called with ${key}="${value}", which the customer never wrote`);
        }
      }
    }
  }
  if (expect.lookupMustNotSucceed && calls.some((c) => c.found === true)) {
    failures.push("lookup_order returned an order, but it must not");
  }
  return failures;
}
