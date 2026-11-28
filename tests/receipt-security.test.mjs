import { test } from "node:test";
import assert from "node:assert/strict";
import { createReceiptHandler } from "../supabase/functions/send-membership-email/handler.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const config = { url: "https://preview.test", anonKey: "anon", serviceKey: "service", from: "test@example.test",
  mailKey: "local-test", termsUrl: "https://terms.example.test/fixture.pdf", testRecipient: "receipt@example.test" };
const baseMember = { id, full_name: "<Synthetic>", email: "receipt@example.test", membership_fee: 123, receipt_sent: false };

function fixture({ role = "staff", member = baseMember, deliver = true } = {}) {
  const actions = [];
  const handler = createReceiptHandler(config, async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith("membership_crm_role")) {
      assert.equal(options.headers.Authorization, "Bearer test-user-token");
      actions.push("role");
      return Response.json(role);
    }
    if (url.pathname === "/rest/v1/members") {
      assert.equal(options.headers.Authorization, "Bearer service");
      assert.equal(url.searchParams.get("id"), `eq.${id}`);
      assert.equal(url.searchParams.get("deleted"), "eq.false");
      actions.push(options.method === "PATCH" ? "mark" : "read");
      return options.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json([member]);
    }
    if (url.hostname === "terms.example.test") {
      assert.equal(options.redirect, "error");
      actions.push("terms");
      return new Response("%PDF-synthetic");
    }
    assert.equal(url.href, "https://api.resend.com/emails");
    const body = JSON.parse(options.body);
    assert.equal(options.headers["Idempotency-Key"], `membership-receipt/${id}`);
    assert.deepEqual(body.to, ["receipt@example.test"]);
    assert.match(body.html, /&lt;Synthetic&gt;/);
    assert.match(body.html, /123.00/);
    assert.equal(body.attachments.length, 2);
    actions.push("send");
    return new Response(null, { status: deliver ? 200 : 400 });
  }, (member) => {
    assert.equal(member.membership_fee, 123);
    return btoa("%PDF-test");
  });
  return { actions, call: (body = { member_id: id }, token = true) => handler(new Request("https://preview.test", {
    method: "POST", headers: token ? { Authorization: "Bearer test-user-token" } : {}, body: JSON.stringify(body),
  })) };
}

test("unauthenticated and unassigned callers cannot reach member data or provider", async () => {
  const test = fixture({ role: null });
  assert.equal((await test.call(undefined, false)).status, 401);
  assert.equal((await test.call()).status, 403);
  assert.deepEqual(test.actions, ["role"]);
});

test("receipt values, attachments and recipient cannot be supplied by the caller", async () => {
  const test = fixture();
  assert.equal((await test.call({ member_id: id, termsPdfUrl: "https://unexpected.test" })).status, 400);
  assert.deepEqual(test.actions, ["role"]);
});

test("only an allowlisted preview recipient is sent a server-built receipt", async () => {
  const blocked = fixture({ member: { ...baseMember, email: "other@example.test" } });
  assert.equal((await blocked.call()).status, 403);
  assert.deepEqual(blocked.actions, ["role", "read"]);
  const allowed = fixture();
  assert.equal((await allowed.call()).status, 200);
  assert.deepEqual(allowed.actions, ["role", "read", "terms", "send", "mark"]);
});

test("provider failure never marks delivery; an already sent receipt does not resend", async () => {
  const failing = fixture({ deliver: false });
  assert.equal((await failing.call()).status, 502);
  assert.ok(!failing.actions.includes("mark"));
  const sent = fixture({ member: { ...baseMember, receipt_sent: true } });
  assert.equal((await sent.call()).status, 200);
  assert.deepEqual(sent.actions, ["role", "read"]);
});
