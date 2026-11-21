const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status, data) => Response.json(data, { status, headers: cors });
const escape = (input) => String(input ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createReceiptHandler(config, request, renderReceipt) {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return reply(401, { error: "Sign in required" });

    try {
      const userHeaders = { apikey: config.anonKey, Authorization: authorization, "Content-Type": "application/json" };
      const role = await request(`${config.url}/rest/v1/rpc/membership_crm_role`, {
        method: "POST", headers: userHeaders, body: "{}",
      });
      if (!role.ok || !["owner", "staff"].includes(await role.json())) {
        return reply(403, { error: "CRM access required" });
      }
      const payload = await req.json();
      if (!payload || Object.keys(payload).length !== 1 ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(payload.member_id ?? "")) {
        return reply(400, { error: "A member ID is required" });
      }
      if (!config.serviceKey || !config.mailKey || !config.from || (!config.testRecipient && config.mode !== "production")) return reply(503, { error: "Receipt delivery is not configured" });

      const headers = { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, "Content-Type": "application/json" };
      const query = new URLSearchParams({
        id: `eq.${payload.member_id}`, deleted: "eq.false",
        select: "id,full_name,card_id,phone,email,join_date,expiry_date,sold_by,payment_method,membership_fee,receipt_sent",
      });
      const endpoint = `${config.url}/rest/v1/members?${query}`;
      const found = await request(endpoint, { headers });
      if (!found.ok) return reply(502, { error: "Could not read receipt details" });
      const [member] = await found.json();
      if (!member?.email) return reply(404, { error: "Active member with email required" });
      if (member.receipt_sent) return reply(200, { success: true, already_sent: true });
      if (config.testRecipient && member.email.toLowerCase() !== config.testRecipient.toLowerCase()) {
        return reply(403, { error: "Recipient is outside the test mailbox allowlist" });
      }

      const attachments = [{
        filename: `${String(member.full_name || "YOHOME_Member").replace(/[^a-z0-9]/gi, "_")}_YOHOME_Membership_Receipt.pdf`,
        content: renderReceipt(member),
      }];
      if (config.termsUrl) {
        const termsUrl = new URL(config.termsUrl);
        if (termsUrl.protocol !== "https:" || termsUrl.username || termsUrl.password) {
          return reply(503, { error: "Terms attachment is not configured correctly" });
        }
        const terms = await request(termsUrl, { redirect: "error" });
        if (!terms.ok || !terms.body) return reply(502, { error: "Could not load the membership terms" });
        const reader = terms.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024) {
            await reader.cancel();
            return reply(502, { error: "Terms attachment is too large" });
          }
          chunks.push(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
        }
        const binary = chunks.join("");
        if (!binary.startsWith("%PDF-")) return reply(502, { error: "Invalid terms attachment" });
        attachments.push({ filename: "YOHOME_Membership_Terms_and_Conditions.pdf", content: btoa(binary) });
      }

      const delivery = await request("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.mailKey}`, "Content-Type": "application/json",
          "Idempotency-Key": `membership-receipt/${member.id}`,
        },
        body: JSON.stringify({
          from: config.from, to: [member.email], subject: "YOHOME Membership Receipt & Terms", attachments,
          html: `<h2>YOHOME Membership Receipt</h2><p>Dear ${escape(member.full_name || "Client")},</p>
            <p>Thank you for purchasing a YOHOME Membership.</p><p>Membership ID: ${escape(member.card_id)}</p>
            <p>Valid Until: ${escape(member.expiry_date)}</p><p>Membership Fee: $${Number(member.membership_fee ?? 0).toFixed(2)}</p>
            <p>Please find attached your membership receipt${config.termsUrl ? " and membership terms &amp; conditions" : ""}.</p>
            <p>Kind regards,<br/>YOHOME Massage &amp; Myotherapy</p>`,
        }),
      });
      if (!delivery.ok) return reply(502, { error: "Receipt provider rejected delivery" });

      const saved = await request(endpoint, {
        method: "PATCH", headers,
        body: JSON.stringify({ receipt_sent: true, receipt_sent_at: new Date().toISOString() }),
      });
      if (!saved.ok) return reply(502, { error: "Delivery accepted but receipt status needs reconciliation" });
      return reply(200, { success: true });
    } catch {
      return reply(502, { error: "Receipt delivery could not be completed" });
    }
  };
}
