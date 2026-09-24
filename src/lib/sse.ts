// Minimal Server Sent Events parser for a fetch() stream. Events are separated by a blank line and each
// one carries a JSON payload on a `data:` line. Network chunks can split an event anywhere, so callers
// keep the returned `rest` and prepend it to the next chunk.
export function parseSseBuffer<T = unknown>(buffer: string): { events: T[]; rest: string } {
  const events: T[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end === -1) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue; // comment lines (": keep-alive") and empty blocks
    try {
      events.push(JSON.parse(data) as T);
    } catch {
      // A malformed event is skipped instead of breaking the whole stream.
    }
  }
  return { events, rest };
}
