import { chromium } from "playwright-core";
// Drives the running app in the installed Chrome. Start it first with `npm run dev`.
//   npm run ui:check
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS_DIR;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const ok = (name, pass, extra = "") => { results.push(`${pass ? "PASS" : "FAIL"}  ${name} ${extra}`); };

// Desktop storefront
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
ok("home title", (await page.title()).includes("Ember"));
ok("h1 present", (await page.locator("h1").innerText()).includes("Small batch"));
ok("5 featured products", (await page.locator("#featured ~ div [data-slot=card]").count()) === 5);
ok("chat region present", await page.getByRole("region", { name: "Store assistant" }).isVisible());
ok("suggestion chips", (await page.getByRole("button", { name: /How much is shipping/ }).count()) === 1);
await shot(page, "desktop");

// Chat: with a model key an answer with sources appears, without one a friendly error with retry appears.
await page.getByRole("button", { name: /How much is shipping/ }).click();
const outcome = await Promise.race([
  page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 60000 }).then(() => "error"),
  page.getByRole("list", { name: "Sources" }).waitFor({ timeout: 60000 }).then(() => "answer"),
]);
ok(`chat produced a visible ${outcome === "answer" ? "answer with sources" : "error with retry"}`, true);
ok("user message kept", await page.getByText("How much is shipping?").first().isVisible());
await shot(page, "chat");

// Mobile
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(`${BASE}/`, { waitUntil: "networkidle" });
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
ok("no horizontal scroll on mobile", !overflow);
await shot(mobile, "mobile");

// Admin redirect and login page
const anon = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await anon.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
ok("admin redirects to login when signed out", anon.url().endsWith("/admin/login"));
await anon.getByLabel("Email").fill("owner@emberandoak.example");
await anon.getByLabel("Password").fill("definitely-wrong");
await anon.getByRole("button", { name: "Sign in" }).click();
await anon.getByText("Email or password is incorrect.").waitFor({ timeout: 10000 });
ok("wrong password shows one generic message", true);
ok("font is Geist, not a serif fallback", (await anon.evaluate(() => getComputedStyle(document.body).fontFamily)).toLowerCase().includes("geist"));
await shot(anon, "login");

// Optional: signed in admin flow. Set ADMIN_EMAIL and ADMIN_PASSWORD (from `npm run make-admin`).
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const admin = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await admin.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await admin.getByLabel("Email").fill(process.env.ADMIN_EMAIL);
  await admin.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
  await admin.getByRole("button", { name: "Sign in" }).click();
  await admin.getByRole("heading", { name: /Ember & Oak assistant/ }).waitFor({ timeout: 15000 });
  ok("admin signs in and sees the dashboard", admin.url().endsWith("/admin"));
  ok("KPI tiles render", (await admin.getByRole("region", { name: "Key numbers" }).locator("[data-slot=card]").count()) === 4);
  ok("low stock lists sold out and low stock items", (await admin.getByText("Sumatra Mandheling").count()) > 0 && (await admin.getByText("Electric Burr Grinder").count()) > 0);
  await shot(admin, "admin");
  await admin.getByRole("button", { name: "Sign out" }).click();
  await admin.waitForURL(/\/admin\/login/);
  ok("sign out returns to login", true);
  await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  ok("dashboard is closed again after sign out", admin.url().endsWith("/admin/login"));
}

ok("no console or page errors", errors.filter((e) => !e.includes("503") && !e.includes("chat request failed") && !e.includes("stream ended early")).length === 0, errors.join(" | ").slice(0, 200));
console.log(results.join("\n"));
await browser.close();
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
