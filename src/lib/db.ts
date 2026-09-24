import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "./env";
import type { Source } from "./guard";

// The public chat and WhatsApp routes run on the server with the service role key. That key bypasses RLS,
// so this module exposes ONLY the fixed operations below. The model never gets SQL or a table name.

export type ProductRow = {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  stock_qty: number;
  in_stock: boolean;
};

export type OrderRow = {
  order_number: string;
  status: string;
  placed_at: string;
  carrier: string | null;
  tracking_number: string | null;
  estimated_delivery: string | null;
  total_cents: number;
  items: { sku: string; name: string; qty: number }[];
};

export type StoredMessage = { role: "user" | "assistant"; content: string };

export type SaveMessage = StoredMessage & {
  conversationId: string;
  citations?: unknown[];
  tools?: string[];
  outcome?: "answered" | "refused" | "fallback" | "error" | "rate_limited";
  model?: string;
  latencyMs?: number;
};

export type Db = {
  hybridSearch(queryText: string, embedding: number[], limit: number): Promise<Source[]>;
  getProducts(query?: string, sku?: string, category?: string): Promise<ProductRow[]>;
  lookupOrder(orderNumber: string, email: string): Promise<OrderRow | null>;
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  isRateLimited(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  getOrCreateConversation(channel: "web" | "whatsapp", externalId?: string, existingId?: string): Promise<string>;
  recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  saveMessage(message: SaveMessage): Promise<void>;
};

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what}: ${error.message}`);
}

export function createDb(): Db {
  const env = getEnv();
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async hybridSearch(queryText, embedding, limit) {
      const { data, error } = await supabase.rpc("hybrid_search", {
        query_text: queryText,
        query_embedding: JSON.stringify(embedding),
        match_count: limit,
      });
      if (error) fail("hybrid_search failed", error);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        chunkId: Number(r.chunk_id),
        docSlug: String(r.doc_slug),
        docKind: String(r.doc_kind),
        docTitle: String(r.doc_title),
        heading: (r.heading as string | null) ?? null,
        content: String(r.content),
      }));
    },

    async getProducts(query, sku, category) {
      const { data, error } = await supabase.rpc("get_products", {
        p_query: query ?? null,
        p_sku: sku ?? null,
        p_category: category ?? null,
      });
      if (error) fail("get_products failed", error);
      return (data ?? []) as ProductRow[];
    },

    async lookupOrder(orderNumber, email) {
      const { data, error } = await supabase.rpc("lookup_order", { p_order_number: orderNumber, p_email: email });
      if (error) fail("lookup_order failed", error);
      return ((data ?? [])[0] as OrderRow | undefined) ?? null;
    },

    async hitRateLimit(key, limit, windowSeconds) {
      const { data, error } = await supabase.rpc("hit_rate_limit", {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) fail("hit_rate_limit failed", error);
      return data === true;
    },

    async isRateLimited(key, limit, windowSeconds) {
      const { data, error } = await supabase.rpc("is_rate_limited", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error) fail("is_rate_limited failed", error);
      return data === true;
    },

    async getOrCreateConversation(channel, externalId, existingId) {
      if (existingId) {
        const { data } = await supabase.from("conversations").select("id").eq("id", existingId).eq("channel", channel).maybeSingle();
        if (data) return data.id as string;
      }
      if (externalId) {
        const { data } = await supabase
          .from("conversations")
          .select("id")
          .eq("channel", channel)
          .eq("external_id", externalId)
          .maybeSingle();
        if (data) return data.id as string;
      }
      const { data, error } = await supabase
        .from("conversations")
        .insert({ channel, external_id: externalId ?? null })
        .select("id")
        .single();
      if (error) fail("create conversation failed", error);
      return data.id as string;
    },

    async recentMessages(conversationId, limit) {
      const { data, error } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("id", { ascending: false })
        .limit(limit);
      if (error) fail("read messages failed", error);
      return ((data ?? []) as StoredMessage[]).reverse();
    },

    async saveMessage(m) {
      const { error } = await supabase.from("messages").insert({
        conversation_id: m.conversationId,
        role: m.role,
        content: m.content,
        citations: m.citations ?? [],
        tools: m.tools ?? [],
        outcome: m.outcome ?? null,
        model: m.model ?? null,
        latency_ms: m.latencyMs ?? null,
      });
      if (error) fail("save message failed", error);
    },
  };
}
