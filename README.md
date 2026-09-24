# Ember & Oak Store Assistant

A customer chat assistant for an online store (demo business: a fictional specialty coffee roaster).
It answers questions from the store's own documents with a source on every answer, reads price, stock and
order status live from the database, refuses when it does not know, streams its replies, has a WhatsApp
adapter, and comes with an owner dashboard and an evaluation suite.

Stack: Next.js 16 (App Router) + TypeScript, Supabase (Postgres + pgvector + Auth), Gemini (chat and
embeddings), shadcn/ui.

## What it does

- **Grounded answers with citations.** Hybrid search (keyword + vector, merged by reciprocal rank fusion)
  over policies, brewing guides, an FAQ and one document per product. Every factual sentence carries a
  source marker, and markers that do not point at a retrieved source are removed.
- **Live facts come from tools, not from documents.** Price, stock and order status are read from the
  database at answer time (`get_products`, `lookup_order`), so they are never stale in an embedding.
- **Honest refusals.** If the sources and tools do not answer, it says so and points to support. A long
  answer with no citation and no tool result is replaced by a fallback instead of being shown.
- **Streaming** over Server Sent Events with Stop, a "connection interrupted" state that keeps the partial
  answer, and retry.
- **WhatsApp** (official Cloud API) webhook with verification handshake, HMAC signature check on the raw
  body, message de-duplication, and a fast 200 with the reply sent after the response.
- **Owner dashboard** (`/admin`): conversation outcomes, knowledge base health (warns if any chunk has no
  embedding), low stock.
- **Evals**: 34 golden cases with record and replay of model calls, run in CI without a key.

## Architecture

```
Browser ──POST /api/chat (SSE)──▶ handleMessage()  ◀── WhatsApp webhook ── Meta
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼                              ▼                               ▼
  embed query (Gemini)        hybrid_search() RPC             tool loop (max 3 steps)
                              (published docs only)           get_products / lookup_order
                                       │                               │
                                       └──────────▶ prompt: rules + untrusted-data wrapped sources
                                                              │
                                                       Gemini stream ──▶ guard.checkAnswer()
                                                              │           (citations, refusal, fallback)
                                                       messages log ◀───────┘
```

`src/lib/chat.ts` is the core and depends only on two small interfaces (`Db`, `Llm`), so it is tested
without a network. `db.ts` exposes a fixed set of operations, never SQL.

## Security decisions

| Decision | Why |
|---|---|
| RLS on every table, `anon` and `authenticated` revoked by default, then only what admins need | Policies alone do not remove default grants. Verified with 48 pgTAP tests, and over raw REST. |
| The public chat runs on the server with the **service role** key, calling only fixed functions | Store knowledge and order lookups are not per user data, so per user RLS does not fit. The exception is contained: the key is server only (`server-only`), the model never gets SQL, all functions have `search_path` pinned, and `EXECUTE` is revoked from `public`, `anon` and `authenticated`. |
| `lookup_order` needs order number AND email and gives the same answer for a wrong email and a missing order | No probing. It returns no name or address, and lookups are rate limited per visitor and per order number. |
| Retrieved documents and tool results are wrapped in a random untrusted-data boundary and the model has no write tools | Prompt injection defence: the worst a poisoned document can do is change wording, not act. Covered by an indirect injection eval case. |
| Citations are validated against what was actually retrieved | The model cannot cite a source it was not given. |
| Card like numbers are masked before storage | Emails are not masked in the log because a customer may give the email and order number in separate messages. **Set a retention job** (for example delete `messages` older than 30 days) before real use. |
| WhatsApp signature is HMAC-SHA256 of the raw body keyed with the **app secret**, constant time compare | The verify token is not the signing key. Tested, including a body re-serialised differently. |
| Chat endpoint rejects cross-origin browser calls | It spends model quota. |
| Generic error text to visitors, real cause only in server logs | No internal detail leaks. |

## Setup (local)

Requirements: Node 22, Docker (for the local Supabase; Colima works on macOS).

```bash
npm install
npx supabase start          # first run downloads images
cp .env.example .env.local  # then fill in values (see below)
npm run ingest              # embeds the knowledge base (needs GEMINI_API_KEY)
npm run make-admin -- owner@emberandoak.example   # prints a password once
npm run dev                 # http://localhost:3000  and  /admin
```

`npx supabase status -o env` prints the local URL and keys for `.env.local`. Get a free Gemini key at
https://aistudio.google.com/apikey.

**Free tier privacy:** Google's free Gemini tier may use your content to improve its products. Use demo
data only. For real customer data use a paid key or Vertex AI.

## Commands

| Command | What it does |
|---|---|
| `npm test` | unit tests (chunker, guard, chat loop, WhatsApp, SSE parser, record and replay) |
| `npm run test:db` | pgTAP tests: RLS, function privileges, order rules, hybrid search |
| `npm run typecheck` / `npm run lint` | static checks |
| `npm run ingest` | load and embed documents. Unchanged documents are skipped, `-- --force` re-embeds all |
| `npm run eval` | golden questions against the live model |
| `npm run eval:record` | same, and store every model response in `evals/recordings/` |
| `npm run eval:replay` | no key, no network: replays stored responses (use in CI) |
| `npm run db:reset` | rebuild the database from migrations and seed |

Evals fail the run if the pass rate is under 90% (`EVAL_MIN_PASS`) or if **any** injection or privacy case
fails. `EVAL_ONLY=<category or id part>` runs a subset.

Recorded results: 34/34 live, 34/34 replayed with no key. Typical answer time is about 1.5 to 3 s.

## Model limits and failures

- The free Gemini tier allows 15 requests per minute per model. On a 429 the app reads the provider's
  "retry in N s" hint and waits if it is at most `GEMINI_MAX_RETRY_WAIT_MS` (default 5 s for customers, 90 s in
  the eval scripts). A longer wait shows the visitor "we are getting a lot of questions" instead of an error.
- A stream that produces no first chunk in 15 s is retried, and so is a network error before the first chunk.
  Nothing is retried after text has started, and a visitor pressing Stop is never retried.
- Order lookups: 8 per visitor per 10 minutes, and 20 failed attempts per order number per hour. Only failures
  count per order number, so real customers are not blocked by earlier successful checks. Migrations 1 to 3.

## WhatsApp

Set `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
`WHATSAPP_GRAPH_VERSION` (check Meta's current version), and point Meta's webhook at `/api/whatsapp`.
The signature check and message parsing are tested with simulated payloads. **It has not been connected to a
real Meta account.** Without the settings the route verifies and logs but does not reply.

## Known limits

- Embeddings use plain text. `gemini-embedding-2` takes no task type and wants task instructions in the text;
  the exact format was not verified, so retrieval quality is measured by the evals instead.
- `X-Forwarded-For` is used for rate limits and is only trustworthy behind a proxy you control.
- The hybrid search ranks with window functions, which is fine at this size. At large scale switch to an
  index friendly query.
- No payment, refund or order changes by design.
- Not deployed. See the deployment notes in the Figure Things Out knowledge base before choosing a target.
