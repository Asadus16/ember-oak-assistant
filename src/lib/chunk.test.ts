import { describe, expect, it } from "vitest";
import { chunkMarkdown, embeddingText, MAX_CHARS } from "./chunk";

describe("chunkMarkdown", () => {
  it("splits at headings and keeps the heading with its section", () => {
    const chunks = chunkMarkdown("# Shipping\n\n## Costs\nFree over 50 dollars.\n\n## Speed\nTwo days.");
    expect(chunks).toEqual([
      { heading: "Costs", content: "Free over 50 dollars." },
      { heading: "Speed", content: "Two days." },
    ]);
  });

  it("keeps text that appears before the first heading", () => {
    const chunks = chunkMarkdown("Intro line.\n\n## Part\nBody.");
    expect(chunks[0]).toEqual({ heading: null, content: "Intro line." });
  });

  it("skips empty sections", () => {
    expect(chunkMarkdown("# A\n\n## B\n\n## C\ntext")).toEqual([{ heading: "C", content: "text" }]);
  });

  it("splits a long section on paragraph boundaries without losing text", () => {
    const paragraph = "word ".repeat(150).trim(); // 749 chars
    const chunks = chunkMarkdown(`## Long\n${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(chunks.map((c) => c.content).join(" ").split(/\s+/).length).toBe(450);
  });

  it("splits one huge paragraph on sentence ends", () => {
    const sentence = "This is a sentence about coffee. ";
    const chunks = chunkMarkdown(`## Big\n${sentence.repeat(80)}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("builds embedding text from title, heading and content", () => {
    expect(embeddingText("Shipping", { heading: "Costs", content: "Free over 50." })).toBe("Shipping\nCosts\nFree over 50.");
    expect(embeddingText("FAQ", { heading: null, content: "x" })).toBe("FAQ\nx");
  });
});
