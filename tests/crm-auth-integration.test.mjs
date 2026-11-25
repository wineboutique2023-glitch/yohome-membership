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
  await db.exec(await sql("../supabase/migrations/20261122020000_gift_card_workflow.sql"));
  await db.exec(await sql("../supabase/migrations/20261123000000_manage_gift_card_records.sql"));
  await db.exec(await sql("../supabase/migrations/20261125000000_legacy_claim_expiry.sql"));
  await db.exec(await sql("../supabase/migrations/20261125010000_complete_card_history.sql"));
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
  await gift(staff, "claim", { barcode, amount: 10000, old_expires_on: "2020-01-01" });
  await assert.rejects(gift(staff, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Attempt" }), /Owner access/);
  await gift(owner, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Checked evidence", physical_card_verified: true });
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
  await gift(staff, "claim", { barcode, amount: 10000, old_expires_on: "2020-01-01" });
  await assert.rejects(gift(staff, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Attempt" }), /Owner access/);
  await gift(owner, "approve", { barcode, amount: 10000, expires_on: expiry, reason: "Checked", physical_card_verified: true });
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
  await sell("MGT-SOLD");
  const lookup = { barcode: "000MGT-CANCEL" };
  await assert.rejects(gift(staff, "stock", lookup), /Owner access/);
  await assert.rejects(gift(staff, "manage_list", {}, null), /Owner access/);
  await gift(owner, "stock", { ...lookup, reason: "New printed cards" });
  await assert.rejects(gift(owner, "stock", lookup), /duplicate/);
  const cards = await gift(owner, "manage_list", {}, null);
  assert.equal(cards.find((card) => card.barcode === lookup.barcode).status, "stock");
  assert.equal(cards.find((card) => card.barcode === "MGT-SOLD").original_value, 10000);
  assert.ok((await gift(owner, "manage_list", { after: lookup.barcode }, null)).every((card) => card.barcode !== lookup.barcode));
  await assert.rejects(gift(owner, "cancel_card", { barcode: "MGT-SOLD", reason: "Sold" }), /without transactions/);
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
  assert.deepEqual(saved.history.map((event) => event.action).sort(), ["cancel_card", "correct_card", "stock"]);
  assert.equal(saved.history.find((event) => event.action === "stock").result.reason, "New printed cards");
  assert.equal((await crm(owner, "receipts")).total, before.total);
  await assert.rejects(gift(staff, "sale", { ...lookup, amount: 5000, expires_on: expiry, payment: "Cash" }), /unused stock card/);
  await assert.rejects(gift(staff, "quote", { ...lookup, service_code: "original" }), /active unexpired/);
  await assert.rejects(gift(owner, "cancel_card", { barcode: "00LESS", reason: "Already used" }), /without transactions/);
  await assert.rejects(gift(owner, "cancel_card", { barcode: "00099", reason: "Replacement" }), /without transactions/);
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

test("anonymous checkout applies a specified dollar amount and settles only once", async () => {
  const barcode = "FLOW-DOLLAR";
  await gift(owner, "stock", { barcode });
  await gift(staff, "sale", { barcode, amount: 10000, expires_on: expiry, payment: "Cash" });
  const args = { barcode, service_code: "cheaper", redeem_amount: 2500 };
  await assert.rejects(gift(staff, "quote", { ...args, redeem_amount: 6500 }), /Redeem amount/);
  const quote = await gift(staff, "quote", args);
  assert.deepEqual([quote.redeemed, quote.topup, quote.after], [2500, 3500, 7500]);
  const before = await crm(owner, "receipts");
  const request = { ...args, quote, payment: "Tyro", payment_confirmed: true };
  const reference = randomUUID();
  const result = await gift(staff, "redeem", request, reference);
  assert.deepEqual(await gift(staff, "redeem", request, reference), result);
  await assert.rejects(gift(staff, "redeem", request), /Price or balance changed/);
  const row = (await crm(owner, "snapshot")).checkouts.find((entry) => entry.gift_request_id === reference);
  assert.deepEqual([row.member_id, row.customer_type, row.cash_received], [null, "guest", 35]);
  assert.equal((await crm(owner, "receipts")).total - before.total, 35);
  const finalArgs = { barcode, service_code: "original", redeem_amount: 7500 };
  await gift(staff, "redeem", { ...finalArgs, quote: await gift(staff, "quote", finalArgs),
    payment: "Cash", payment_confirmed: true });
  assert.equal((await gift(staff, "lookup", { barcode })).status, "spent");
});

test("verified old card transfer and owner stock registration are atomic", async () => {
  const barcode = "FLOW-OLD";
  const replacement = "FLOW-NEW";
  const barcodes = [replacement, "FLOW-NEW-2"];
  await assert.rejects(gift(staff, "stock_batch", { barcodes }), /Owner access/);
  const batch = randomUUID();
  assert.equal((await gift(owner, "stock_batch", { barcodes }, batch)).stock_count, 2);
  assert.equal((await gift(owner, "stock_batch", { barcodes }, batch)).stock_count, 2);
  await assert.rejects(gift(owner, "stock_batch", { barcodes: [replacement, "FLOW-ROLLBACK"] }), /already registered/);
  await assert.rejects(gift(owner, "lookup", { barcode: "FLOW-ROLLBACK" }), /Card not found/);
  await assert.rejects(gift(staff, "manage_lookup", { barcode: replacement }), /Owner access/);
  assert.ok((await gift(owner, "manage_lookup", { barcode: replacement })).history.some((entry) => entry.action === "stock_batch"));
  await assert.rejects(gift(staff, "claim", { barcode: replacement, amount: 1234, old_expires_on: "2020-01-01" }), /duplicate/);
  await assert.rejects(gift(staff, "quote", { barcode: replacement, service_code: "original" }), /active unexpired/);
  await gift(staff, "claim", { barcode, amount: 1234, old_expires_on: "2020-01-01" });
  await assert.rejects(gift(staff, "quote", { barcode, service_code: "original" }), /active unexpired/);
  const approve = { barcode, amount: 1234, expires_on: expiry, reason: "Checked old card" };
  await assert.rejects(gift(owner, "approve", approve), /Verify the physical/);
  await gift(owner, "approve", { ...approve, physical_card_verified: true });
  const before = (await crm(owner, "receipts")).total;
  const transfer = { barcode, replacement, amount: 1234, old_card_collected: true };
  await assert.rejects(gift(staff, "transfer", { ...transfer, amount: 1235 }), /Balance changed/);
  await assert.rejects(gift(staff, "transfer", { ...transfer, old_card_collected: false }), /Collect/);
  const id = randomUUID();
  const result = await gift(staff, "transfer", transfer, id);
  assert.deepEqual(await gift(staff, "transfer", transfer, id), result);
  await assert.rejects(gift(staff, "transfer", transfer), /Collect/);
  const newCard = await gift(staff, "lookup", { barcode: replacement });
  assert.deepEqual([newCard.balance, newCard.expires_on, newCard.status], [1234, expiry, "active"]);
  assert.equal((await gift(staff, "lookup", { barcode })).status, "exchanged");
  assert.equal((await crm(owner, "receipts")).total, before);
});

test("expired old card claims require Owner review and keep the original expiry and audit", async () => {
  const barcode = "000-EXPIRED-CLAIM";
  const claim = { barcode, amount: 10500, old_expires_on: "2020-02-01" };
  await assert.rejects(gift(staff, "claim", { barcode, amount: 10500 }), /old card expiry date/);
  await gift(staff, "claim", claim);
  await assert.rejects(gift(staff, "pending", { barcode }, null), /Owner access/);
  const [item] = await gift(owner, "pending", { barcode }, null);
  assert.deepEqual([item.barcode, item.claim.claimed, item.claim.old_expires_on, item.claim.actor_name],
    [barcode, 10500, "2020-02-01", "Staff"]);
  assert.ok(item.submitted_at);
  assert.equal(item.balance, 0);
  await assert.rejects(gift(owner, "correct_card", { barcode, reason: "Edit", registration_note: "Edit" }), /Approve Old Cards/);
  await assert.rejects(gift(owner, "cancel_card", { barcode, reason: "Cancel" }), /without transactions/);
  const approval = { barcode, amount: 8000, expires_on: expiry, reason: "Verified",
    physical_card_verified: true, review_notes: "Physical card checked" };
  await assert.rejects(gift(staff, "approve", approval), /Owner access/);
  await assert.rejects(gift(staff, "adjust", { barcode, amount: 8000, reason: "Change" }), /Owner access/);
  await gift(owner, "approve", approval);
  assert.deepEqual(await gift(owner, "pending", { barcode }, null), []);
  const card = await gift(owner, "manage_lookup", { barcode }, null);
  assert.deepEqual([card.status, card.balance, card.expires_on], ["active", 8000, expiry]);
  const decision = card.history.find((event) => event.action === "approve");
  assert.deepEqual([decision.result.actor_name, decision.result.reason, decision.result.review_notes],
    ["Owner", "Verified", "Physical card checked"]);
  assert.ok(decision.created_at);
  assert.equal(card.history.find((event) => event.action === "claim").result.old_expires_on, "2020-02-01");
  const rejected = { ...claim, barcode: "000-REJECTED-CLAIM" };
  await gift(staff, "claim", rejected);
  await gift(owner, "reject", { barcode: rejected.barcode, reason: "Verification failed" });
  const rejectedCard = await gift(owner, "manage_lookup", { barcode: rejected.barcode }, null);
  assert.deepEqual([rejectedCard.status, rejectedCard.balance], ["rejected", 0]);
});

test("card history returns every permitted record beyond the former 100-entry limit", async () => {
  const barcode = "000-HISTORY-PAGES";
  await gift(owner, "stock", { barcode });
  await db.query(`
    insert into gift_private.events (request_id, actor, action, barcode, request, result, created_at)
    select gen_random_uuid(), $1, 'redeem', $2, '{}'::jsonb,
      jsonb_build_object('barcode',$2::text,'before',n,'after',n-1,'reason','Internal'),
      now() - n * interval '1 second'
    from generate_series(1, 105) as n
  `, [owner, barcode]);
  const staffHistory = (await gift(staff, "lookup", { barcode }, null)).history;
  const ownerHistory = (await gift(owner, "manage_lookup", { barcode }, null)).history;
  assert.equal(staffHistory.length, 105);
  assert.equal(ownerHistory.length, 106);
  assert.deepEqual(staffHistory.map((event) => event.result.before), Array.from({ length: 105 }, (_, i) => i + 1));
  assert.ok(staffHistory.every((event) => !Object.hasOwn(event.result, "reason")));
});
