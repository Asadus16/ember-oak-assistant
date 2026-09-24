import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/supabase/server";
import { signOut } from "./actions";

export const metadata = { title: "Admin | Ember & Oak", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type MessageRow = {
  id: number;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  outcome: string | null;
  tools: string[];
  citations: unknown[];
  latency_ms: number | null;
  created_at: string;
};

const OUTCOME_STYLE: Record<string, string> = {
  answered: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  refused: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  fallback: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  rate_limited: "bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200",
  error: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

const shorten = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export default async function AdminPage() {
  const { supabase, user, isAdmin } = await requireAdmin();
  if (!user) redirect("/admin/login");

  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-lg font-semibold">Not authorized</h1>
        <p className="mt-2 text-sm text-muted-foreground">This account is signed in but is not a store admin.</p>
        <form action={signOut} className="mt-4">
          <Button variant="outline" type="submit">
            Sign out
          </Button>
        </form>
      </main>
    );
  }

  const [conversations, answers, recent, docs, missing, lowStock] = await Promise.all([
    supabase.from("conversations").select("*", { count: "exact", head: true }),
    supabase.from("messages").select("outcome, latency_ms").eq("role", "assistant").order("id", { ascending: false }).limit(500),
    supabase
      .from("messages")
      .select("id, conversation_id, role, content, outcome, tools, citations, latency_ms, created_at")
      .order("id", { ascending: false })
      .limit(80),
    supabase.from("knowledge_docs").select("slug, kind, title, published, knowledge_chunks(count)").order("kind").order("title"),
    supabase.from("knowledge_chunks").select("*", { count: "exact", head: true }).is("embedding", null),
    supabase.from("products").select("sku, name, stock_qty").lte("stock_qty", 5).order("stock_qty").limit(10),
  ]);

  const outcomes = answers.data ?? [];
  const count = (o: string) => outcomes.filter((m) => m.outcome === o).length;
  const total = outcomes.length;
  const latencies = outcomes.map((m) => m.latency_ms).filter((n): n is number => typeof n === "number");
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const needsAttention = count("refused") + count("fallback") + count("error");

  // Pair each assistant reply with the customer message that came right before it in the same conversation.
  const ascending = [...((recent.data ?? []) as MessageRow[])].reverse();
  const lastUser = new Map<string, string>();
  const exchanges = ascending
    .flatMap((m) => {
      if (m.role === "user") {
        lastUser.set(m.conversation_id, m.content);
        return [];
      }
      return [{ ...m, question: lastUser.get(m.conversation_id) ?? "" }];
    })
    .reverse()
    .slice(0, 25);

  const unembedded = missing.count ?? 0;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Ember &amp; Oak assistant</h1>
          <p className="text-sm text-muted-foreground">Signed in as {user.email}</p>
        </div>
        <form action={signOut}>
          <Button variant="outline" type="submit">
            Sign out
          </Button>
        </form>
      </header>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Conversations" value={String(conversations.count ?? 0)} />
        <Kpi label="Answers logged" value={String(total)} hint="last 500" />
        <Kpi label="Answered" value={total ? `${Math.round((count("answered") / total) * 100)}%` : "n/a"} hint={`${count("answered")} of ${total}`} />
        <Kpi label="Needs attention" value={String(needsAttention)} hint={avgLatency ? `avg ${avgLatency} ms` : "refused, fallback or error"} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent exchanges</CardTitle>
          <CardDescription>What customers asked and how the assistant handled it. Refused and fallback answers show gaps in the knowledge base.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer asked</TableHead>
                <TableHead>Assistant replied</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead className="text-right">Sources</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exchanges.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No conversations yet.
                  </TableCell>
                </TableRow>
              )}
              {exchanges.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="max-w-56 whitespace-normal">{shorten(m.question, 90)}</TableCell>
                  <TableCell className="max-w-72 whitespace-normal">{shorten(m.content)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={OUTCOME_STYLE[m.outcome ?? ""] ?? ""}>
                      {m.outcome ?? "n/a"}
                    </Badge>
                  </TableCell>
                  <TableCell>{m.tools.length ? m.tools.join(", ") : "none"}</TableCell>
                  <TableCell className="text-right">{m.citations.length}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{m.latency_ms ? `${m.latency_ms} ms` : "n/a"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Knowledge base</CardTitle>
            <CardDescription>
              {unembedded > 0 ? (
                <span role="alert" className="font-medium text-destructive">
                  {unembedded} chunk(s) have no embedding and cannot be found by search. Run npm run ingest -- --force.
                </span>
              ) : (docs.data ?? []).length === 0 ? (
                <span role="alert" className="font-medium text-destructive">
                  No documents yet, so the assistant cannot answer from store information. Run npm run ingest.
                </span>
              ) : (
                "Every chunk is embedded and searchable."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(docs.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      Nothing ingested yet.
                    </TableCell>
                  </TableRow>
                )}
                {(docs.data ?? []).map((d) => (
                  <TableRow key={d.slug}>
                    <TableCell>
                      {d.title}
                      {!d.published && <span className="ml-2 text-xs text-muted-foreground">(unpublished)</span>}
                    </TableCell>
                    <TableCell>{d.kind}</TableCell>
                    <TableCell className="text-right">{(d.knowledge_chunks as unknown as { count: number }[])[0]?.count ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Low stock</CardTitle>
            <CardDescription>Products with 5 or fewer units. The assistant reads stock live, so it stays accurate.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">In stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lowStock.data ?? []).map((p) => (
                  <TableRow key={p.sku}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right">{p.stock_qty === 0 ? "sold out" : p.stock_qty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}
