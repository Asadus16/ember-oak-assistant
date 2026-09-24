import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import type { Db } from "./db";

// Two read only tools. The model can only choose a tool and fill validated arguments; it never sees SQL,
// table names or the database client.
export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_products",
    description:
      "Look up LIVE price and stock for products. Use it for any question about price, availability or whether the store sells something. Give product name or category words in query, or an exact sku.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or category words, for example 'ethiopia' or 'grinder'. Max 60 characters." },
        sku: { type: "string", description: "Exact SKU such as EO-COF-001." },
      },
    },
  },
  {
    name: "lookup_order",
    description:
      "Look up the status of ONE order. Requires BOTH the order number (like EO-10002) and the email address used at checkout. Never guess either value.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        order_number: { type: "string", description: "Order number such as EO-10002." },
        email: { type: "string", description: "Email address used at checkout." },
      },
      required: ["order_number", "email"],
    },
  },
];

const productArgs = z
  .object({ query: z.string().trim().max(60).optional(), sku: z.string().trim().max(30).optional() })
  .refine((a) => Boolean(a.query) || Boolean(a.sku), { message: "query or sku is required" });

const orderArgs = z.object({
  order_number: z.string().trim().regex(/^EO-\d{4,8}$/i),
  email: z.email().max(254),
});

export type ToolContext = { db: Db; clientKey: string };

const usd = (cents: number) => (cents / 100).toFixed(2);

function availability(stock: number): string {
  if (stock <= 0) return "sold out";
  if (stock <= 5) return `low stock (${stock} left)`;
  return "in stock";
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (name === "get_products") {
    const args = productArgs.safeParse(rawArgs);
    if (!args.success) return { error: "invalid_arguments", message: "Provide a product name, category or SKU." };
    const rows = await ctx.db.getProducts(args.data.query, args.data.sku);
    if (rows.length === 0) return { found: false, message: "No matching product in the catalog." };
    return {
      found: true,
      products: rows.map((r) => ({
        sku: r.sku,
        name: r.name,
        category: r.category,
        price_usd: usd(r.price_cents),
        availability: availability(r.stock_qty),
      })),
    };
  }

  if (name === "lookup_order") {
    const args = orderArgs.safeParse(rawArgs);
    if (!args.success) {
      return { error: "invalid_arguments", message: "Ask the customer for a valid order number (like EO-10002) and the email used at checkout." };
    }
    const orderNumber = args.data.order_number.toUpperCase();
    // Two limits slow down guessing. Per visitor: every lookup counts. Per order number: only FAILED lookups
    // count, so real customers checking their own order are never blocked by earlier successful checks. The
    // threshold is high on purpose, because anyone who fails repeatedly on an order number also blocks its
    // real owner for the rest of the hour. That is the price of stopping distributed guessing.
    const visitorOk = await ctx.db.hitRateLimit(`order-client:${ctx.clientKey}`, 8, 600);
    const blocked = !visitorOk || (await ctx.db.isRateLimited(`order-failed:${orderNumber}`, 20, 3600));
    if (blocked) return { error: "too_many_attempts", message: "Too many lookups. Ask the customer to wait or email support." };

    const order = await ctx.db.lookupOrder(orderNumber, args.data.email);
    // Same answer for a wrong email and for a missing order, so nothing can be learned by probing.
    if (!order) {
      await ctx.db.hitRateLimit(`order-failed:${orderNumber}`, 20, 3600);
      return { found: false, message: "No order matches that order number and email." };
    }
    return {
      found: true,
      order_number: order.order_number,
      status: order.status,
      placed_on: order.placed_at.slice(0, 10),
      carrier: order.carrier,
      tracking_number: order.tracking_number,
      estimated_delivery: order.estimated_delivery,
      total_usd: usd(order.total_cents),
      items: order.items,
    };
  }

  return { error: "unknown_tool" };
}
