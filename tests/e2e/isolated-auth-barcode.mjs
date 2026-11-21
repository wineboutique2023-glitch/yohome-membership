import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createServer as createViteServer } from "vite";

const external = process.env.YOHOME_E2E_TOOLS;
const binaries = process.env.YOHOME_E2E_BINARIES;
if (!external || !binaries) throw new Error("Set YOHOME_E2E_TOOLS and YOHOME_E2E_BINARIES as documented.");
const require = createRequire(resolve(external, "package.json"));
const { default: EmbeddedPostgres } = await import(require.resolve("embedded-postgres"));
const { chromium } = require("playwright-core");
const databaseDir = await mkdtemp("/tmp/yohome-crm-db-");
const postgresPassword = randomUUID();
const restPassword = randomUUID();
const secret = randomUUID() + randomUUID();
const pgUri = (user, password) => `postgres://${user}:${password}@127.0.0.1:55433/postgres?sslmode=disable`;
const pg = new EmbeddedPostgres({
  databaseDir, user: "postgres", password: postgresPassword, port: 55433, persistent: false,
  autoRehydrateSymlinks: true,
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="],
  onLog: () => {}, onError: console.error,
});
const authUrl = "http://127.0.0.1:55434";
const restUrl = "http://127.0.0.1:55435";
const gatewayUrl = "http://127.0.0.1:55436";
const browserUrl = "http://127.0.0.1:55437";
const children = [];
const diagnostics = new Map();

function run(name, variables) {
  const child = spawn(resolve(binaries, name), [], { cwd: binaries, env: { ...process.env, ...variables }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let logs = "";
  for (const pipe of [child.stderr, child.stdout]) pipe.on("data", (chunk) => {
    logs = (logs + chunk).slice(-3000);
    diagnostics.set(name, logs);
  });
  return () => { if (child.exitCode != null) throw new Error(`${name} exited: ${logs}`); };
}

async function waitFor(url, check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    check();
    try { if ((await fetch(url)).ok) return; } catch { /* Starting. */ }
    await setTimeout(100);
  }
  throw new Error(`Service did not start at ${url}`);
}

function signedAnonKey() {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role: "anon", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}

async function request(url, body, token) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
}

async function json(response) {
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

async function rpc(token, action_name, args = {}, gift = false) {
  const name = gift ? "membership_gift_card" : "membership_crm";
  return json(await request(`${restUrl}/rpc/${name}`, { action_name, args, ...(gift && { operation_id: randomUUID() }) }, token));
}

let browser;
let vite;
let gateway;
let admin;
try {
  await pg.initialise();
  await pg.start();
  admin = pg.getPgClient();
  await admin.connect();
  await admin.query("create schema auth");
  const authCheck = run("auth", {
    GOTRUE_API_HOST: "127.0.0.1", GOTRUE_API_PORT: "55434", API_EXTERNAL_URL: authUrl,
    GOTRUE_SITE_URL: browserUrl, GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: pgUri("postgres", postgresPassword) + "&search_path=auth,public", GOTRUE_DB_NAMESPACE: "auth",
    GOTRUE_DB_MIGRATIONS_PATH: resolve(binaries, "migrations"),
    GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated", GOTRUE_JWT_EXP: "3600",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_MAILER_AUTOCONFIRM: "true",
    GOTRUE_DISABLE_SIGNUP: "false",
  });
  await waitFor(`${authUrl}/health`, authCheck);

  const fixture = await readFile(new URL("../fixtures/crm.sql", import.meta.url), "utf8");
  const sql = fixture.replace("create schema auth;\n", "").replace("create table auth.users(id uuid primary key);\n", "")
    .replaceAll("create function auth.", "create or replace function auth.")
    .replace("nullif(current_setting('request.jwt.claim.sub',true),'')::uuid", "(auth.jwt()->>'sub')::uuid")
    .replace(/(create or replace function auth.uid\(\)[\s\S]*?\$\$;\n)(create or replace function auth.jwt\(\)[\s\S]*?\$\$;\n)/, "$2$1");
  await admin.query(sql);
  for (const migration of ["20261121000000_gift_cards.sql", "20261121010000_crm_auth_gift_checkout.sql", "20261121020000_preserve_legacy_crm_behaviour.sql", "20261121030000_receipt_status_server_only.sql"]) {
    await admin.query(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
  await admin.query(`create role authenticator login noinherit password '${restPassword}';
    grant anon,authenticated to authenticator;
    insert into public.service_items(id,name,normal_price,member_price,staff_pay) values
      ('original','Original gift service',100,80,35),('cheaper','Cheaper gift service',60,50,25);
    insert into public.members(card_id,full_name,expiry_date) values ('MEM1','Scanner Test Member','2099-11-21');`);
  const restCheck = run("postgrest", {
    PGRST_DB_URI: pgUri("authenticator", restPassword), PGRST_DB_SCHEMAS: "public",
    PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: secret, PGRST_JWT_AUD: "authenticated",
    PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: "55435",
  });
  await waitFor(restUrl, restCheck);

  const ownerCreds = { email: "owner@example.test", password: randomUUID() };
  const staffCreds = { email: "staff@example.test", password: randomUUID() };
  const strangerCreds = { email: "stranger@example.test", password: randomUUID() };
  for (const credentials of [ownerCreds, staffCreds]) await json(await request(`${authUrl}/signup`, credentials));
  const owner = await json(await request(`${authUrl}/token?grant_type=password`, ownerCreds));
  const staff = await json(await request(`${authUrl}/token?grant_type=password`, staffCreds));
  const stranger = await json(await request(`${authUrl}/signup`, strangerCreds));
  await admin.query("insert into gift_private.users(user_id,role,display_name) values ($1,'owner','Test Owner'),($2,'staff','Test Staff')", [owner.user.id, staff.user.id]);
  const checkRole = async (token) => json(await request(`${restUrl}/rpc/membership_crm_role`, {}, token));
  assert.equal(await checkRole(owner.access_token), "owner");
  assert.equal(await checkRole(staff.access_token), "staff");
  assert.equal(await checkRole(stranger.access_token), null);
  assert.equal((await request(`${restUrl}/rpc/membership_crm`, { action_name: "snapshot" })).status, 401);
  assert.equal((await request(`${restUrl}/rpc/membership_crm`, { action_name: "receipts" }, staff.access_token)).status, 400);
  const snapshot = await rpc(staff.access_token, "snapshot");
  assert.ok(snapshot.services.every((s) => !Object.hasOwn(s, "staff_pay")));
  assert.deepEqual(await json(await fetch(`${restUrl}/service_items?select=staff_pay`, { headers: { Authorization: `Bearer ${staff.access_token}` } })), []);
  for (const [service_code, name, amount] of [["original","Original gift service",10000],["cheaper","Cheaper gift service",6000]]) {
    await rpc(owner.access_token, "set_service", { service_code, name, amount }, true);
  }
  await rpc(owner.access_token, "stock", { barcode: "0000123" }, true);
  await rpc(staff.access_token, "sale", { barcode: "0000123", service_code: "original", expires_on: "2099-11-21", payment: "Tyro" }, true);

  gateway = createHttpServer(async (req, res) => {
    const headers = { "Access-Control-Allow-Origin": browserUrl,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, headers).end(); return; }
    const match = req.url.match(/^\/(auth|rest)\/v1(\/.*)$/);
    if (!match) { res.writeHead(404, headers).end(); return; }
    const [, service, path] = match;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch((service === "auth" ? authUrl : restUrl) + path, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["host", "connection", "content-length", "origin"].includes(name))),
      ...(chunks.length && { body: Buffer.concat(chunks) }),
    });
    res.writeHead(response.status, { ...headers, "Content-Type": response.headers.get("content-type") ?? "text/plain" });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolveGateway) => gateway.listen(55436, "127.0.0.1", resolveGateway));
  process.env.VITE_SUPABASE_URL = gatewayUrl;
  process.env.VITE_SUPABASE_ANON_KEY = signedAnonKey();
  process.env.VITE_ENABLE_GIFT_CARDS = "true";
  vite = await createViteServer({ server: { host: "127.0.0.1", port: 55437, strictPort: true } });
  await vite.listen();
  const shell = process.env.YOHOME_HEADLESS_SHELL === "true" ? require("@sparticuz/chromium").default : null;
  browser = await chromium.launch({ executablePath: shell ? await shell.executablePath() : process.env.YOHOME_CHROMIUM || "/usr/bin/chromium",
    args: shell ? shell.args : ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(browserUrl);
  await page.getByLabel("Email").fill(staffCreds.email);
  await page.getByLabel("Password").fill(staffCreds.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Checkout", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reports", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Checkout", exact: true }).click();
  await page.getByRole("button", { name: "Gift Card Checkout", exact: true }).click();
  await page.getByLabel("Barcode", { exact: true }).pressSequentially("0000123");
  await page.getByLabel("Barcode", { exact: true }).press("Enter");
  await page.getByText(/0000123 · active/).waitFor();
  await page.locator("select[name=service_code]").selectOption("cheaper");
  await page.getByRole("button", { name: "Calculate gift card payment" }).click();
  await page.getByText(/Unused service gift value/).waitFor();
  await page.locator("select[name=member_id]").selectOption(snapshot.members[0].id);
  await page.getByRole("button", { name: "Confirm gift card checkout" }).click();
  assert.equal((await rpc(owner.access_token, "receipts")).checkouts, 0);
  await page.getByLabel(/Customer confirmed/).check();
  await page.getByRole("button", { name: "Confirm gift card checkout" }).click();
  await page.getByText("Saved.", { exact: true }).waitFor();
  const ownerSnapshot = await rpc(owner.access_token, "snapshot");
  assert.equal(ownerSnapshot.checkouts.length, 1);
  assert.equal(ownerSnapshot.checkouts[0].member_id, snapshot.members[0].id);
  assert.equal(ownerSnapshot.checkouts[0].gift_unused_value, 40);
  assert.equal((await rpc(owner.access_token, "receipts")).total, 100);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill(ownerCreds.email);
  await page.getByLabel("Password").fill(ownerCreds.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (const tab of ["Dashboard", "Members", "Checkout", "Services", "Staff", "Analytics", "Reports", "Settings"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.getByRole("heading", { name: tab.toUpperCase(), exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await page.getByRole("heading", { name: "Reports & Backup" }).waitFor();
  await page.getByText("Total Receipts", { exact: true }).waitFor();
  assert.match(await page.locator(".checkoutTable").innerText(), /Scanner Test Member[\s\S]*Gift \$60.00 · Paid \$0.00/);
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: "View Profile", exact: true }).click();
  await page.getByRole("heading", { name: "Treatment History", exact: true }).waitFor();
  await page.getByText("Total Spent", { exact: true }).waitFor();
  assert.match(await page.locator(".historyPanel").innerText(), /Cheaper gift service[\s\S]*Gift \$60.00 · Paid \$0.00/);
  await page.locator(".modeBox select").selectOption("staff");
  await page.getByText("Total Members", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reports", exact: true }).count(), 0);
  await page.locator(".modeBox select").selectOption("owner");
  await page.getByRole("button", { name: "Reports", exact: true }).waitFor();
  await admin.query("update gift_private.users set active=false where user_id=$1", [staff.user.id]);
  assert.equal(await checkRole(staff.access_token), null);
  console.log("Passed Supabase Auth, PostgREST, PostgreSQL and Chromium end-to-end test with simulated keyboard-wedge scanner input.");
} catch (error) {
  for (const [name, logs] of diagnostics) console.error(name, logs.replaceAll(secret, "[redacted]"));
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  gateway?.close();
  for (const child of children) child.kill();
  await admin?.end();
  await pg.stop().catch(() => {});
}
