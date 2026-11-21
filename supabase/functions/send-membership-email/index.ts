import { jsPDF } from "npm:jspdf@4.2.1";
import { autoTable } from "npm:jspdf-autotable@5.0.7";
import { createReceiptHandler } from "./handler.mjs";

function makeMembershipReceiptPDF(member: Record<string, string | number | null>) {
  const doc = new jsPDF();
  doc.setCreationDate(new Date(`${member.join_date || "2000-01-01"}T00:00:00Z`));
  doc.setFileId(String(member.id).replaceAll("-", "").toUpperCase());

  doc.setFontSize(16);
  doc.text("YOHOME Massage & Myotherapy", 14, 16);
  doc.setFontSize(13);
  doc.text("Membership Receipt", 14, 26);

  doc.setFontSize(10);
  doc.text(`Receipt Date: ${member.join_date || ""}`, 14, 40);
  doc.text(`Member Name: ${String(member.full_name ?? "")}`, 14, 48);
  doc.text(`Member ID: ${String(member.card_id ?? "")}`, 14, 56);
  doc.text(`Phone: ${String(member.phone ?? "")}`, 14, 64);
  doc.text(`Email: ${String(member.email ?? "")}`, 14, 72);
  doc.text(`Join Date: ${member.join_date || ""}`, 14, 80);
  doc.text(`Expiry Date: ${member.expiry_date || ""}`, 14, 88);
  doc.text(`Sold By: ${String(member.sold_by ?? "")}`, 14, 96);
  doc.text(`Payment Method: ${String(member.payment_method ?? "")}`, 14, 104);
  doc.text(`Membership Fee: $${Number(member.membership_fee ?? 0).toFixed(2)}`, 14, 112);

  autoTable(doc, {
    startY: 124,
    head: [["Item", "Amount"]],
    body: [["YOHOME 12-Month Membership", `$${Number(member.membership_fee ?? 0).toFixed(2)}`]],
  });

  doc.setFontSize(9);
  doc.text("Thank you for purchasing a YOHOME membership.", 14, 160);
  doc.text("Please keep this receipt for your records.", 14, 167);

  return doc.output("datauristring").split(",")[1];
}


Deno.serve(createReceiptHandler({
  url: Deno.env.get("SUPABASE_URL"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  mailKey: Deno.env.get("RESEND_API_KEY"),
  from: Deno.env.get("FROM_EMAIL"),
  termsUrl: Deno.env.get("MEMBERSHIP_TERMS_PDF_URL"),
  mode: Deno.env.get("MEMBERSHIP_EMAIL_MODE"),
  testRecipient: Deno.env.get("MEMBERSHIP_TEST_RECIPIENT"),
}, fetch, makeMembershipReceiptPDF));
