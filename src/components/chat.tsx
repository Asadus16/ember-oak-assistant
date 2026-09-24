"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatEvent } from "@/lib/chat";
import type { Citation } from "@/lib/guard";
import { stripMarkers } from "@/lib/markers";
import { parseSseBuffer } from "@/lib/sse";

type Message = {
  id: number;
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  state: "streaming" | "done" | "error";
  note?: string;
};

const STORAGE_KEY = "eo_conversation";
const MAX_LENGTH = 1000;

const SUGGESTIONS = [
  "How much is shipping?",
  "Which coffee is best for pour-over?",
  "Is the Sumatra Mandheling in stock?",
  "Where is my order EO-10002? My email is sam.okafor@example.com",
];

const TOOL_NOTES: Record<string, string> = {
  get_products: "Checking live price and stock...",
  lookup_order: "Looking up your order...",
};

// Citation markers like [S1] are shown as chips under the answer, not inside the sentence.

function readConversationId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined; // private mode or blocked storage: the chat still works, it just starts fresh
  }
}

function saveConversationId(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<string | undefined>(undefined);
  const lastQuestion = useRef("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    conversationRef.current = readConversationId();
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const update = useCallback((id: number, patch: (m: Message) => Message) => {
    setMessages((all) => all.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;
      lastQuestion.current = question;

      const userId = nextId.current++;
      const replyId = nextId.current++;
      setMessages((all) => [
        ...all,
        { id: userId, role: "user", text: question, citations: [], state: "done" },
        { id: replyId, role: "assistant", text: "", citations: [], state: "streaming" },
      ]);
      setInput("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let finished = false;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: question, conversationId: conversationRef.current }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`status ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSseBuffer<ChatEvent>(buffer + decoder.decode(value, { stream: true }));
          buffer = parsed.rest;

          for (const event of parsed.events) {
            if (event.type === "meta") {
              conversationRef.current = event.conversationId;
              saveConversationId(event.conversationId);
            } else if (event.type === "token") {
              update(replyId, (m) => ({ ...m, text: m.text + event.text, note: undefined }));
            } else if (event.type === "tool") {
              update(replyId, (m) => ({ ...m, note: TOOL_NOTES[event.name] ?? "Working on it..." }));
            } else if (event.type === "done") {
              finished = true;
              // The server's text is authoritative: it may differ from what was streamed.
              update(replyId, (m) => ({ ...m, text: event.text, citations: event.citations, state: "done", note: undefined }));
              setAnnouncement(stripMarkers(event.text));
            }
          }
        }

        if (!finished) throw new Error("stream ended early");
      } catch (error) {
        if (controller.signal.aborted) {
          // The visitor pressed Stop: keep what was written and say so.
          update(replyId, (m) => ({ ...m, state: "done", note: "Stopped." }));
        } else {
          console.error("chat request failed", error);
          update(replyId, (m) => ({ ...m, state: "error", note: "The connection was interrupted." }));
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, update],
  );

  return (
    <section aria-label="Store assistant" className="flex h-[36rem] max-h-[80dvh] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Ask Ember &amp; Oak</h2>
        <p className="text-xs text-muted-foreground">Answers come from our store information. It cannot change orders.</p>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log" aria-label="Conversation" tabIndex={0}>
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Ask about coffee, brewing, gear, shipping or your order.</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-full border px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                  : "max-w-[90%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm"
              }
            >
              {m.role === "assistant" && m.state === "streaming" && !m.text ? (
                <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
              ) : (
                <p className="whitespace-pre-wrap">{stripMarkers(m.text)}</p>
              )}

              {m.note && (
                <p className="mt-1 text-xs text-muted-foreground" role={m.state === "error" ? "alert" : undefined}>
                  {m.note}
                </p>
              )}

              {m.citations.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Sources">
                  {m.citations.map((c) => (
                    <li key={c.marker} className="rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                      {c.title}
                      {c.heading ? ` › ${c.heading}` : ""}
                    </li>
                  ))}
                </ul>
              )}

              {m.state === "error" && (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void send(lastQuestion.current)} disabled={busy}>
                  Try again
                </Button>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Screen readers hear the finished answer once, not every streamed token. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <form
        className="flex gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Your question
        </label>
        <Input
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
          placeholder="Type your question"
          autoComplete="off"
          maxLength={MAX_LENGTH}
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={input.trim().length === 0}>
            Send
          </Button>
        )}
      </form>
    </section>
  );
}
