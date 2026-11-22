import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const owner = randomUUID();
const staff = randomUUID();
const stranger = randomUUID();
const member = randomUUID();
const removed = randomUUID();
const expiry = "2099-11-21";
let originalRows;

async function sql(file) {
  return readFile(new URL(file, import.meta.url), "utf8");
}

before(async () => {
  await db.exec(await sql("./fixtures/crm.sql"));
  await db.query("insert into public.members(id,card_id,full_name,expiry_date,notes,deleted) values ($1,'MEM','Test Member',$3,'Private note',false),($2,'REM','Removed',$3,'Private',true)", [member, removed, expiry]);
  await db.exec(`insert into public.service_items(id,name,normal_price,member_price,staff_pay) values
    ('original','Original',100,80,35),('upgrade','Upgrade',140,110,45),('cheaper','Cheaper',60,50,25);
    insert into public.checkouts(service_name,duration,original_price,final_price,staff_pay,shop_profit)
      values ('Pre-existing receipt',1,25,25,10,15);`);
  const original = await db.query("select (select jsonb_agg(to_jsonb(m) order by id) from public.members m) as members, (select jsonb_agg(to_jsonb(c) order by id) from public.checkouts c) as checkouts");
  originalRows = original.rows[0];
  await db.exec(await sql("../supabase/migrations/20261121000000_gift_cards.sql"));
  await db.query("insert into auth.users values ($1),($2),($3)", [owner, staff, stranger]);
  await db.query("insert into gift_private.users(user_id,role,display_name) values ($1,'owner','Owner'),($2,'staff','Staff')", [owner, staff]);
  await db.exec(await sql("../supabase/migrations/20261121010000_crm_auth_gift_checkout.sql"));
  await db.exec(await sql("../supabase/migrations/20261121020000_preserve_legacy_crm_behaviour.sql"));
  await db.exec(await sql("../supabase/migrations/20261121030000_receipt_status_server_only.sql"));
  await db.exec(await sql("../supabase/migrations/20261122000000_gift_crm_service_catalog.sql"));
  await db.exec(await sql("../supabase/migrations/20261122010000_gift_card_management.sql"));
});
after(() => db.close());

function as(user, query, params = [], claims = {}) {
  return db.transaction(async (tx) => {
    await tx.exec(user ? "set local role authenticated" : "set local role anon");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [user ?? "", JSON.stringify(claims)]);
    return (await tx.query(query, params)).rows;
  });
}

async function crm(user, action, args = {}) {
  return (await as(user, "select public.membership_crm($1,$2) as result", [action, args]))[0].result;
}

async function gift(user, action, args = {}, id = randomUUID()) {
  return (await as(user, "select public.membership_gift_card($1,$2,$3) as result", [action, args, id]))[0].result;
}

async function sell(barcode) {
  await gift(owner, "stock", { barcode });
  await gift(staff, "sale", { barcode, service_code: "original", expires_on: expiry, payment: "Tyro", amount: 1 });
}

test("roles enforce permissions and preserve existing data", async () => {
  const actual = await db.query("select (select jsonb_agg(to_jsonb(m) order by id) from public.members m) as members, (select jsonb_agg(to_jsonb(c)-'gift_request_id'-'gift_applied'-'gift_unused_value'-'cash_received' order by id) from public.checkouts c) as checkouts");
  assert.deepEqual(actual.rows[0], originalRows);
  for (const table of ["members", "checkouts", "service_items", "sales_people", "system_settings"]) {
    await assert.rejects(as(null, `select * from public.${table}`), /permission denied/);
    assert.deepEqual(await as(staff, `select * from public.${table}`), []);
  }
  await assert.rejects(crm(stranger, "snapshot"), /CRM access is required/);
  assert.equal((await as(staff, "select public.membership_crm_role() as role", [], { is_anonymous: true }))[0].role, null);
  assert.equal((await crm(owner, "snapshot")).members.find((m) => m.id === member).notes, "Private note");
  const snapshot = await crm(staff, "snapshot");
  assert.ok(snapshot.members.every((m) => !m.deleted && !Object.hasOwn(m, "notes")));
  assert.ok(snapshot.checkouts.every((c) => !Object.hasOwn(c, "staff_pay") && !Object.hasOwn(c, "shop_profit")));
  assert.ok(snapshot.services.every((s) => !Object.hasOwn(s, "staff_pay")));
  await assert.rejects(crm(staff, "receipts"), /Owner access is required/);
  await assert.rejects(as(staff, "select gift_private.operate('overview','{}',null)"), /permission denied/);
  await assert.rejects(as(staff, "insert into public.system_settings values ('membership_fee','1')"), /row-level security/);
  assert.deepEqual(await as(staff, "update public.members set full_name='Altered' returning id"), []);
  assert.equal((await crm(owner, "receipts")).total, 25);
  assert.equal((await db.query("select count(*)::int from pg_policies where tablename in ('clients','intake_forms','soap_notes') and policyname='legacy_public'")).rows[0].count, 3);
});

test("staff enrols and renews members and checkout validates live prices", async () => {
  const saved = await crm(staff, "add_member", { full_name: "New Member", card_id: "NEW", membership_fee: 1 });
  assert.equal(Number(saved.membership_fee), 100);
  await assert.rejects(crm(staff, "mark_receipt", { member_id: saved.id }), /server-managed/);
  await crm(staff, "renew_member", { member_id: saved.id });
  await assert.rejects(crm(staff, "renew_member", { member_id: removed }), /Active member record not found/);
  const args = { service_id: "original", member_id: member, therapist: "Test Therapist", payment_method: "Cash" };
  await assert.rejects(crm(staff, "checkout", { ...args, expected_price: 1 }), /Price changed/);
  await crm(staff, "checkout", { ...args, expected_price: 80, staff_pay: 1, price_note: "Staff override" });
  const row = (await crm(owner, "snapshot")).checkouts.find((r) => r.member_id === member);
  assert.deepEqual([row.final_price, row.staff_pay, row.price_note], [80, 35, "Member price applied."]);
});

test("upgrade creates one member checkout and recognizes the sale and cash top-up once", async () => {
  const before = await crm(owner, "receipts");
  await sell("00UP");
  await assert.rejects(gift(owner, "set_service", { service_code: "original", name: "Changed", amount: 12000 }), /CRM Services/);
  await as(owner, "update public.service_items set name='Changed', normal_price=120, duration=1.5 where id='original'");
  const catalog = (await gift(staff, "overview")).services;
  assert.deepEqual(catalog.find((service) => service.code === "original"),
    { code: "original", name: "Changed", price: 12000, duration: 1.5, active: true });
  const originalQuote = await gift(staff, "quote", { barcode: "00UP", service_code: "original" });
  assert.deepEqual([originalQuote.service_name, originalQuote.service_duration, originalQuote.service_price], ["Original", 1, 10000]);
  await as(owner, "update public.service_items set name='Original', normal_price=100, duration=1 where id='original'");
  const args = { barcode: "00UP", service_code: "upgrade" };
  const quote = await gift(staff, "quote", args);
  assert.equal(quote.topup, 4000);
  const redemption = { ...args, quote, payment: "Tyro", payment_confirmed: true, member_id: member };
  const id = randomUUID();
  await assert.rejects(gift(staff, "redeem", { ...redemption, member_id: removed }, id), /Active member record not found/);
  assert.equal((await gift(staff, "lookup", { barcode: args.barcode })).balance, 10000);
  const result = await gift(staff, "redeem", redemption, id);
  assert.deepEqual(await gift(staff, "redeem", redemption, id), result);
  const all = (await crm(owner, "snapshot")).checkouts.filter((r) => r.gift_request_id === id);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].member_id, all[0].final_price, all[0].gift_applied, all[0].cash_received], [member, 140, 100, 40]);
  const after = await crm(owner, "receipts");
  assert.equal(after.total - before.total, 140);
  assert.equal(after.gift_sales - before.gift_sales, 100);
  assert.equal(after.checkouts - before.checkouts, 40);
  await assert.rejects(as(owner, "delete from public.checkouts where gift_request_id=$1", [id]), /ledger-controlled/);
  await assert.rejects(as(owner, "update public.checkouts set cash_received=0 where gift_request_id=$1", [id]), /ledger-controlled/);
});

test("cheaper service requires explicit confirmation and legacy exchange keeps its balance", async () => {
  await sell("00LESS");
  const args = { barcode: "00LESS", service_code: "cheaper" };
  const quote = await gift(staff, "quote", args);
  assert.equal(quote.service_value_released, 4000);
  await assert.rejects(gift(staff, "redeem", { ...args, quote, unused_value_confirmed: "true" }), /Customer confirmation/);
  await gift(staff, "redeem", { ...args, quote, unused_value_confirmed: true, member_id: member });
  assert.ok((await crm(owner, "snapshot")).checkouts.some((r) => r.gift_unused_value === 40 && r.cash_received === 0));
  const barcode = "OLD2";
  const replacement = "00099";
  await gift(staff, "claim", { barcode, amount: 10000, reason: "Old physical card" });
  await assert.rejects(gift(staff, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Attempt" }), /Owner access/);
  await gift(owner, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Checked evidence" });
  await gift(owner, "stock", { barcode: replacement });
  const exchange = { barcode, service_code: "cheaper", replacement, old_card_collected: true, member_id: member };
  const before = await crm(owner, "receipts");
  await gift(staff, "exchange", { ...exchange, quote: await gift(staff, "quote", exchange) });
  assert.equal((await gift(staff, "lookup", { barcode: replacement })).balance, 4000);
  assert.equal((await gift(staff, "lookup", { barcode })).status, "exchanged");
  assert.equal((await crm(owner, "receipts")).total, before.total);
});

test("legacy checkout retains configured discount, first-hour note, UTC date and payroll", async () => {
  await db.exec(`insert into public.service_items(id,name,duration,normal_price,member_price,staff_pay,discount_type,discount_value)
    values ('old-discount','Old service',1,140,null,35,'%',25), ('old-short','Old short',0.5,60,50,15,'$',10);`);
  await crm(staff, "checkout", { service_id: "old-discount", member_id: member, expected_price: 105,
    payment_method: "Cash", checkout_date: "2025-05-01", therapist: "Before" });
  await crm(staff, "checkout", { service_id: "old-discount", member_id: member, expected_price: 40,
    payment_method: "Redeem First Hour Massage", checkout_date: "2025-05-02" });
  await assert.rejects(crm(staff, "checkout", { service_id: "old-short", member_id: member, expected_price: 0,
    payment_method: "Redeem First Hour Massage" }), /at least 60 minutes/);
  const snapshot = await crm(owner, "snapshot");
  const rows = snapshot.checkouts.filter((row) => row.service_name === "Old service");
  assert.deepEqual(rows.reverse().map((r) => [r.final_price, r.staff_pay, r.shop_profit, r.created_at.slice(0,19), r.price_note]), [
    [105,35,70,"2025-05-01T12:00:00","Member price applied."],
    [40,35,5,"2025-05-02T12:00:00","Redeem First Hour applied: $100 value redeemed. Customer pays extra $40.00."],
  ]);
  const view = await crm(owner, "snapshot", { staff_view: true });
  assert.ok(view.checkouts.every((r) => !Object.hasOwn(r, "staff_pay") && !Object.hasOwn(r, "shop_profit")));
  assert.ok(view.members.every((m) => !Object.hasOwn(m, "notes") && !m.deleted));
  await assert.rejects(crm(staff, "renew_member", { member_id: member, expiry_date: "2099-01-01" }), /one-year rule/);
});

test("release: receipt status is server-managed and a $100 legacy card exchanges $50 exactly once", async () => {
  await assert.rejects(crm(staff, "mark_receipt", { member_id: member }), /server-managed/);
  await assert.rejects(as(owner, "update public.members set receipt_sent=true where id=$1", [member]), /server-managed/);
  await db.exec("insert into public.service_items(id,name,normal_price) values ('release-50','Release 50',50)");
  const replacement = "00000050";
  const barcode = "RELEASE-100";
  await gift(staff, "claim", { barcode, amount: 10000, reason: "Synthetic old card" });
  await assert.rejects(gift(staff, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Attempt" }), /Owner access/);
  await gift(owner, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Checked" });
  await gift(owner, "stock", { barcode: replacement });
  const draft = { barcode, replacement, old_card_collected: true, member_id: member, service_code: "release-50" };
  const args = { ...draft, quote: await gift(staff, "quote", draft) };
  const reference = randomUUID();
  const before = await crm(owner, "receipts");
  const result = await gift(staff, "exchange", args, reference);
  assert.deepEqual(await gift(staff, "exchange", args, reference), result);
  await assert.rejects(gift(staff, "exchange", args), /active unexpired card/);
  assert.equal((await gift(staff, "lookup", { barcode: replacement })).balance, 5000);
  assert.equal((await crm(owner, "snapshot")).checkouts.filter((row) => row.gift_request_id === reference).length, 1);
  assert.equal((await crm(owner, "receipts")).total, before.total);
});

test("owner corrections and cancellation retain card history and recorded receipts", async () => {
  await sell("MGT-CANCEL");
  const lookup = { barcode: "MGT-CANCEL" };
  const before = await crm(owner, "receipts");
  const correction = { ...lookup, reason: "Wrong label", registration_note: "Corrected label" };
  await assert.rejects(gift(staff, "correct_card", correction), /Owner access/);
  await assert.rejects(gift(staff, "cancel_card", { ...lookup, reason: "Wrong card" }), /Owner access/);
  await gift(owner, "correct_card", correction);
  assert.equal((await gift(owner, "lookup", lookup)).registration_note, "Corrected label");
  assert.equal(Object.hasOwn(await gift(staff, "lookup", lookup), "registration_note"), false);
  await assert.rejects(gift(owner, "cancel_card", lookup), /cancellation reason/);
  const cancel = { ...lookup, reason: "Wrong card" };
  const operation = randomUUID();
  const result = await gift(owner, "cancel_card", cancel, operation);
  assert.deepEqual(await gift(owner, "cancel_card", cancel, operation), result);
  const saved = await gift(owner, "lookup", lookup);
  assert.deepEqual([saved.status, saved.balance, saved.can_cancel], ["cancelled", 0, false]);
  assert.deepEqual(saved.history.map((event) => event.action).sort(), ["cancel_card", "correct_card", "sale", "stock"]);
  assert.equal((await crm(owner, "receipts")).total, before.total);
  await assert.rejects(gift(staff, "quote", { ...lookup, service_code: "original" }), /active unexpired/);
  await assert.rejects(gift(owner, "cancel_card", { barcode: "00LESS", reason: "Already used" }), /Only unused/);
  await assert.rejects(gift(owner, "cancel_card", { barcode: "00099", reason: "Replacement" }), /Only unused/);
});

test("gift checkout records the selected service date and validates therapist", async () => {
  await db.exec("insert into public.sales_people(name) values ('Gift Test Therapist')");
  await sell("MGT-DATE");
  const draft = { barcode: "MGT-DATE", service_code: "original", member_id: member, checkout_date: "2026-11-19" };
  const args = { ...draft, quote: await gift(staff, "quote", draft) };
  const operation = randomUUID();
  await assert.rejects(gift(staff, "redeem", { ...args, therapist: "Unknown" }, operation), /active therapist/);
  assert.equal((await gift(staff, "lookup", { barcode: draft.barcode })).balance, 10000);
  await gift(staff, "redeem", { ...args, therapist: "Gift Test Therapist" }, operation);
  const row = (await crm(owner, "snapshot")).checkouts.find((entry) => entry.gift_request_id === operation);
  assert.equal(row.created_at.slice(0, 19), "2026-11-19T12:00:00");
  assert.equal(row.therapist, "Gift Test Therapist");
});
