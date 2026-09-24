import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chat } from "@/components/chat";
import { getDb } from "@/lib/services";

export const dynamic = "force-dynamic";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function Home() {
  // Live catalog data straight from the database (price and stock are never cached in the knowledge base).
  const featured = await getDb()
    .getProducts(undefined, undefined, "coffee")
    .catch(() => []);

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-8">
          <span className="text-lg font-semibold tracking-tight">Ember &amp; Oak</span>
          <span className="text-xs text-muted-foreground">Demo store. All products and orders are fictional.</span>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[1fr_26rem] lg:gap-14 lg:py-16">
        <div className="space-y-12">
          <section aria-labelledby="hero">
            <h1 id="hero" className="max-w-xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Small batch coffee, roasted to order.
            </h1>
            <p className="mt-4 max-w-xl text-lg text-muted-foreground">
              Ask our assistant which coffee suits your taste, how to brew it, what shipping costs, or where your order is. It answers
              from our own store information and shows its sources.
            </p>
          </section>

          <section aria-labelledby="featured">
            <h2 id="featured" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Featured coffees
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {featured.length === 0 && <p className="text-sm text-muted-foreground">The catalog is not available right now.</p>}
              {featured.map((p) => (
                <Card key={p.sku}>
                  <CardHeader>
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <CardDescription>12 oz whole bean</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <span className="font-medium tabular-nums">{usd(p.price_cents)}</span>
                    {p.stock_qty === 0 ? (
                      <Badge variant="secondary">Sold out</Badge>
                    ) : p.stock_qty <= 5 ? (
                      <Badge variant="secondary">Only {p.stock_qty} left</Badge>
                    ) : (
                      <Badge variant="outline">In stock</Badge>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section aria-labelledby="try" className="rounded-xl border bg-muted/50 p-4 text-sm">
            <h2 id="try" className="font-medium">
              Try the order lookup
            </h2>
            <p className="mt-1 text-muted-foreground">
              Demo order <span className="font-mono">EO-10002</span> with email <span className="font-mono">sam.okafor@example.com</span>. The
              assistant needs both, and shows the same answer for a wrong email as for a missing order.
            </p>
          </section>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Chat />
        </aside>
      </main>
    </div>
  );
}
