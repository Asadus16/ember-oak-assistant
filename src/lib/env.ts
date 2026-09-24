import { z } from "zod";

// Server side configuration, validated once. Secrets must never be imported from client components.
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Optional so the storefront and admin run without it. Chat and ingest fail with a clear message instead.
  GEMINI_API_KEY: z.string().min(10).optional(),
  // Model ids change often. Both are overridable and were checked against Google's SDK and cookbook.
  GEMINI_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-2"),
  // Answering from given sources and calling two simple tools needs little reasoning. MINIMAL keeps replies fast.
  // Longest wait for a provider "retry in N s" hint. Small for customers, large for evals and batch jobs.
  GEMINI_MAX_RETRY_WAIT_MS: z.coerce.number().int().min(0).default(5000),
  GEMINI_THINKING_LEVEL: z.enum(["MINIMAL", "LOW", "MEDIUM", "HIGH"]).default("MINIMAL"),
  // WhatsApp Cloud API. Optional: without them the route still verifies and logs, but does not reply.
  WHATSAPP_VERIFY_TOKEN: z.string().min(8).optional(),
  WHATSAPP_APP_SECRET: z.string().min(8).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(8).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(3).optional(),
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    // A blank line such as GEMINI_API_KEY= in .env.local means "not set".
    const source = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${names}. See .env.example.`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const EMBEDDING_DIMENSIONS = 768;
