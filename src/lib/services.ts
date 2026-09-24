import "server-only";
import { createDb, type Db } from "./db";
import { createGemini, type Llm } from "./gemini";
import { pseudonym } from "./whatsapp";

let db: Db | undefined;
let llm: Llm | undefined;

export const getDb = () => (db ??= createDb());

export function getDeps() {
  llm ??= createGemini();
  return { db: getDb(), llm };
}

// Pseudonymous visitor key for rate limits. X-Forwarded-For is only trustworthy behind a proxy you control
// (Vercel, a load balancer). Directly exposed, a caller could rotate it, so keep the per key limits low.
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return pseudonym(forwarded || "unknown", "ip");
}
