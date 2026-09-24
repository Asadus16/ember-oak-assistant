// Loads data/knowledge/**/*.md and one descriptive document per product into knowledge_docs and
// knowledge_chunks, and embeds the chunks. Re running only re embeds documents whose text changed.
//
//   npm run ingest            (needs GEMINI_API_KEY in .env.local)
//   npm run ingest -- --force (re embed everything, for example after changing the embedding model)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chunkMarkdown, embeddingText, type Chunk } from "../src/lib/chunk";
import { getEnv } from "../src/lib/env";
import { createGemini } from "../src/lib/gemini";

const force = process.argv.includes("--force");
const BATCH = 16;

type DocInput = { kind: "product" | "guide" | "policy" | "faq"; slug: string; title: string; body: string; productSku?: string };

const KIND_BY_FOLDER: Record<string, DocInput["kind"]> = { policies: "policy", guides: "guide", faq: "faq" };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".md") ? [full] : [];
  });
}

function readKnowledgeFiles(root: string): DocInput[] {
  return walk(root).map((file) => {
    const relative = path.relative(root, file);
    const [folder] = relative.split(path.sep);
    const kind = KIND_BY_FOLDER[folder];
    if (!kind) throw new Error(`Unknown knowledge folder: ${folder}`);
    const body = readFileSync(file, "utf8");
    const title = /^#\s+(.*)$/m.exec(body)?.[1]?.trim() ?? path.basename(file, ".md");
    return { kind, slug: path.basename(file, ".md"), title, body };
  });
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const env = getEnv();
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const llm = createGemini();

  // Product documents hold descriptive text only. Price and stock are live facts and are never embedded.
  const { data: products, error: productError } = await supabase
    .from("products")
    .select("sku, name, category, description, published");
  if (productError) throw new Error(`Reading products failed: ${productError.message}`);

  const docs: DocInput[] = [
    ...readKnowledgeFiles(path.join(process.cwd(), "data", "knowledge")),
    ...(products ?? [])
      .filter((p) => p.published)
      .map((p) => ({
        kind: "product" as const,
        slug: `product-${String(p.sku).toLowerCase()}`,
        title: p.name as string,
        body: `# ${p.name}\n\nCategory: ${p.category}\n\n${p.description}`,
        productSku: p.sku as string,
      })),
  ];

  const { data: existing, error: existingError } = await supabase
    .from("knowledge_docs")
    .select("id, slug, content_hash");
  if (existingError) throw new Error(`Reading documents failed: ${existingError.message}`);
  const bySlug = new Map((existing ?? []).map((d) => [d.slug as string, d]));

  let embedded = 0;
  let skipped = 0;

  for (const doc of docs) {
    const hash = sha(`${env.GEMINI_EMBEDDING_MODEL}\n${doc.title}\n${doc.body}`);
    const current = bySlug.get(doc.slug);
    if (current && current.content_hash === hash && !force) {
      skipped++;
      continue;
    }

    const chunks: Chunk[] = chunkMarkdown(doc.body);
    if (chunks.length === 0) continue;

    const { data: row, error } = await supabase
      .from("knowledge_docs")
      .upsert(
        {
          kind: doc.kind,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          product_sku: doc.productSku ?? null,
          published: true,
          content_hash: hash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "slug" },
      )
      .select("id")
      .single();
    if (error) throw new Error(`Saving document ${doc.slug} failed: ${error.message}`);

    // Replace the chunks in one go so a document never has a mix of old and new text.
    const del = await supabase.from("knowledge_chunks").delete().eq("doc_id", row.id);
    if (del.error) throw new Error(`Clearing chunks of ${doc.slug} failed: ${del.error.message}`);

    const rows: {
      doc_id: number;
      chunk_index: number;
      heading: string | null;
      content: string;
      embedding: string;
      embedding_model: string;
    }[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vectors = await llm.embed(batch.map((c) => embeddingText(doc.title, c)));
      batch.forEach((c, j) =>
        rows.push({
          doc_id: row.id,
          chunk_index: i + j,
          heading: c.heading,
          content: c.content,
          embedding: JSON.stringify(vectors[j]),
          embedding_model: env.GEMINI_EMBEDDING_MODEL,
        }),
      );
      await sleep(400); // stay well inside free tier rate limits
    }
    const ins = await supabase.from("knowledge_chunks").insert(rows);
    if (ins.error) throw new Error(`Saving chunks of ${doc.slug} failed: ${ins.error.message}`);

    embedded++;
    console.log(`embedded ${doc.slug} (${chunks.length} chunks)`);
  }

  // Unpublish documents whose source file or product no longer exists (kept, not deleted, so history survives).
  const liveSlugs = new Set(docs.map((d) => d.slug));
  const stale = (existing ?? []).filter((d) => !liveSlugs.has(d.slug as string)).map((d) => d.id as number);
  if (stale.length > 0) {
    await supabase.from("knowledge_docs").update({ published: false }).in("id", stale);
    console.log(`unpublished ${stale.length} document(s) with no source`);
  }

  console.log(`done: ${embedded} embedded, ${skipped} unchanged, ${docs.length} total`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
