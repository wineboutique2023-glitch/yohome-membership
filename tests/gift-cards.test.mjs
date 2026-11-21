import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const owner = randomUUID();
const staff = randomUUID();
const outsider = randomUUID();
const expires_on = "2099-11-21";
const payment = "Tyro";

before(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.members(id integer primary key);
    insert into public.members values (42);
  `);
  await db.exec(await readFile(new URL("../supabase/migrations/20261121000000_gift_cards.sql", import.meta.url), "utf8"));
  for (const id of [owner, staff, outsider]) await db.query("insert into auth.users values ($1)", [id]);
  await db.query("insert into gift_private.users(user_id,role,display_name) values ($1,'owner','Owner'),($2,'staff','Front Desk')", [owner, staff]);
});

after(() => db.close());

async function operation(user, action, args = {}, id = randomUUID()) {
  return db.transaction(async (tx) => {
    await tx.exec(user ? "set local role authenticated" : "set local role anon");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    const { rows } = await tx.query("select public.membership_gift_card($1,$2::jsonb,$3) as result", [action, JSON.stringify(args), id]);
    return rows[0].result;
  });
}

async function service(service_code, amount) {
  await operation(owner, "set_service", { service_code, amount, name: service_code });
}

test("roles and baseline data are preserved", async () => {
  await assert.rejects(operation(null, "overview"), /permission denied/);
  await assert.rejects(operation(outsider, "overview"), /access is required/);
  assert.equal((await operation(staff, "overview")).role, "staff");
  for (const action of ["stock", "approve", "reject", "adjust", "report", "pending", "set_service"]) {
    await assert.rejects(operation(staff, action), /Owner access is required/);
  }
  for (const table of ["events", "cards", "users", "services"]) {
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.exec(`select * from gift_private.${table}`);
    }), /permission denied/);
  }
  assert.deepEqual((await db.query("select id from public.members")).rows, [{ id: 42 }]);
});

test("stock, sales, price snapshot, top-up and retry protection", async () => {
  await service("original", 10000);
  await service("upgrade", 14000);
  await operation(owner, "stock", { barcode: "00123" });
  await assert.rejects(operation(owner, "stock", { barcode: "00123" }), /duplicate key/);
  const sale = { barcode: "00123", service_code: "original", expires_on, payment };
  const id = randomUUID();
  const sold = await operation(staff, "sale", sale, id);
  assert.equal(sold.service_value, 10000);
  assert.equal(sold.actor_name, "Front Desk");
  assert.deepEqual(await operation(staff, "sale", sale, id), sold);
  await assert.rejects(operation(owner, "sale", sale, id), /already used/);
  await assert.rejects(operation(staff, "sale", sale), /unused stock card/);
  await service("original", 12500);
  const original = await operation(staff, "quote", { barcode: "00123", service_code: "original" });
  assert.equal(original.topup, 0);
  const args = { barcode: "00123", service_code: "upgrade" };
  const quote = await operation(staff, "quote", args);
  assert.equal(quote.topup, 4000);
  await assert.rejects(operation(staff, "redeem", { ...args, quote, payment }), /Confirm the balance payment/);
  await assert.rejects(operation(staff, "redeem", { ...args, quote: { ...quote, topup: 0 } }), /Refresh the quote/);
  const redeemId = randomUUID();
  const redemption = { ...args, quote, payment, payment_confirmed: true };
  const receipt = await operation(staff, "redeem", redemption, redeemId);
  assert.equal(receipt.redeemed, 10000);
  assert.deepEqual(await operation(staff, "redeem", redemption, redeemId), receipt);
  await assert.rejects(operation(staff, "redeem", redemption), /active unexpired card/);
});

test("legacy review, failed exchange rollback and successful balance transfer", async () => {
  await service("half", 5000);
  const barcode = "OLD01";
  const replacement = "00002";
  const args = { barcode, service_code: "half" };
  await operation(staff, "claim", { barcode, amount: 10000, reason: "Paper voucher" });
  await assert.rejects(operation(staff, "quote", args), /active unexpired card/);
  const pending = await operation(owner, "pending");
  assert.equal(pending[0].claim.claimed, 10000);
  await operation(owner, "approve", { barcode, amount: 10000, expires_on, reason: "Verified voucher" });
  const quote = await operation(staff, "quote", args);
  const exchange = { ...args, quote, replacement, old_card_collected: true };
  await assert.rejects(operation(staff, "exchange", exchange), /unused replacement/);
  assert.equal((await operation(staff, "lookup", { barcode })).balance, 10000);
  await operation(owner, "stock", { barcode: replacement });
  await assert.rejects(operation(staff, "exchange", { ...exchange, old_card_collected: false }), /Collect the old/);
  assert.equal((await operation(staff, "exchange", exchange)).transferred, 5000);
  assert.equal((await operation(staff, "lookup", { barcode })).status, "exchanged");
  const newCard = await operation(staff, "lookup", { barcode: replacement });
  assert.equal(newCard.balance, 5000);
  assert.equal(newCard.expires_on, expires_on);
  assert.ok(newCard.history.some((e) => e.action === "exchange"));
  await assert.rejects(operation(staff, "redeem", { ...args, quote }), /active unexpired card/);
  await operation(owner, "adjust", { barcode: replacement, amount: 4500, reason: "Documented correction" });
  const report = await operation(owner, "report");
  assert.deepEqual(
    [report.sold, report.redeemed, report.topup, report.transferred, report.outstanding],
    [10000, 15000, 4000, 5000, 4500]
  );
  assert.ok(report.events.some((e) => e.action === "adjust" && e.result.reason === "Documented correction"));
});

test("rejected claims, stale quotes and expired card sales are blocked", async () => {
  const barcode = "STALE01";
  await operation(staff, "claim", { barcode: "REJECT01", amount: 10000, reason: "Claim" });
  await operation(owner, "reject", { barcode: "REJECT01", reason: "Duplicate claim" });
  await assert.rejects(operation(owner, "approve", { barcode: "REJECT01", amount: 10000, expires_on, reason: "Late" }), /pending claim/);
  await operation(owner, "stock", { barcode });
  await assert.rejects(operation(staff, "sale", { barcode, amount: 10000, expires_on: "2000-01-01", payment }), /valid expiry/);
  await operation(staff, "sale", { barcode, amount: 10000, expires_on, payment });
  const args = { barcode, service_code: "half" };
  const quote = await operation(staff, "quote", args);
  await operation(owner, "adjust", { barcode, amount: 9000, reason: "Reconciliation" });
  await assert.rejects(operation(staff, "redeem", { ...args, quote }), /Refresh the quote/);
});

test("transfer by itself records no new sale or redemption", async () => {
  const beforeReport = await operation(owner, "report");
  const args = { barcode: "STANDALONE", replacement: "00125", old_card_collected: "true", amount: 3000 };
  await operation(staff, "claim", { barcode: args.barcode, amount: args.amount, reason: "Paper voucher" });
  await operation(owner, "approve", { barcode: args.barcode, amount: args.amount, expires_on, reason: "Verified" });
  await operation(owner, "stock", { barcode: args.replacement });
  await assert.rejects(operation(staff, "transfer", { ...args, amount: 2900 }), /Balance changed/);
  assert.equal((await operation(staff, "transfer", args)).transferred, 3000);
  const afterReport = await operation(owner, "report");
  for (const field of ["sold", "redeemed", "topup"]) assert.equal(afterReport[field], beforeReport[field]);
  assert.equal(afterReport.transferred - beforeReport.transferred, 3000);
});

test("an active service gift honours its original service after catalogue deactivation", async () => {
  await service("retired", 9000);
  const barcode = "00126";
  const service_code = "retired";
  await operation(owner, "stock", { barcode });
  await operation(staff, "sale", { barcode, service_code, expires_on, payment });
  await operation(owner, "set_service", { service_code, name: "Archived", amount: 11000, active: false });
  const quote = await operation(staff, "quote", { barcode, service_code });
  assert.equal(quote.service_name, "retired");
  assert.equal(quote.topup, 0);
  assert.equal((await operation(staff, "redeem", { barcode, service_code, quote })).redeemed, 9000);
});

test("owner can void an unused service gift without changing its original value", async () => {
  const barcode = "VOID01";
  const service_code = "upgrade";
  await operation(owner, "stock", { barcode });
  await operation(staff, "sale", { barcode, service_code, expires_on, payment });
  const reason = "Documented void";
  await assert.rejects(operation(owner, "adjust", { barcode, amount: 1, reason }), /original value is fixed/);
  await operation(owner, "adjust", { barcode, amount: 0, reason });
  const card = await operation(owner, "lookup", { barcode });
  assert.deepEqual([card.status, card.balance, card.service_value], ["spent", 0, 14000]);
  await assert.rejects(operation(owner, "adjust", { barcode, amount: 14000, reason }), /original value is fixed/);
});
