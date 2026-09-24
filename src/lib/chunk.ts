// Heading aware markdown chunker. Sections are split at #, ## and ### headings; a section longer than
// MAX_CHARS is split on paragraph boundaries (and, for a single huge paragraph, on sentence ends).

export type Chunk = { heading: string | null; content: string };

export const MAX_CHARS = 1200;

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > MAX_CHARS) {
      push();
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        if (current.length + sentence.length + 1 > MAX_CHARS) push();
        current += (current ? " " : "") + sentence;
      }
      push();
      continue;
    }
    if (current.length + paragraph.length + 2 > MAX_CHARS) push();
    current += (current ? "\n\n" : "") + paragraph;
  }
  push();
  return parts;
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const sections: { heading: string | null; lines: string[] }[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^#{1,3}\s+(.*)$/.exec(line);
    if (match) {
      sections.push(current);
      current = { heading: match[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;
    for (const piece of splitLong(body)) chunks.push({ heading: section.heading, content: piece });
  }
  return chunks;
}

// The text that gets embedded: title and heading give a short chunk the context it needs.
export function embeddingText(docTitle: string, chunk: Chunk): string {
  return [docTitle, chunk.heading, chunk.content].filter(Boolean).join("\n");
}
