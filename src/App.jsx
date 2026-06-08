import { useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import "./App.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const OWNER_PIN = import.meta.env.VITE_OWNER_PIN || "285888";
const TERMS_PDF_URL = import.meta.env.VITE_TERMS_PDF_URL || "";

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const fallbackServices = [
  { id: "deep30", name: "Pain Relief Deep Tissue Therapy - 30 min", duration: 0.5, normal_price: 50, member_price: 50, staff_pay: 15, member_allowed: false, active: true },
  { id: "deep45", name: "Pain Relief Deep Tissue Therapy - 45 min", duration: 0.75, normal_price: 75, member_price: 75, staff_pay: 22.5, member_allowed: false, active: true },
  { id: "deep60", name: "Pain Relief Deep Tissue Therapy - 60 min", duration: 1, normal_price: 100, member_price: 80, staff_pay: 30, member_allowed: true, active: true },
  { id: "deep90", name: "Pain Relief Deep Tissue Therapy - 90 min", duration: 1.5, normal_price: 150, member_price: 120, staff_pay: 45, member_allowed: true, active: true },
  { id: "injury30", name: "Injury Recovery Massage Therapy - 30 min", duration: 0.5, normal_price: 60, member_price: 60, staff_pay: 15, member_allowed: false, active: true },
  { id: "injury45", name: "Injury Recovery Massage Therapy - 45 min", duration: 0.75, normal_price: 80, member_price: 80, staff_pay: 22.5, member_allowed: false, active: true },
  { id: "injury60", name: "Injury Recovery Massage Therapy - 60 min", duration: 1, normal_price: 110, member_price: 80, staff_pay: 30, member_allowed: true, active: true },
  { id: "injury90", name: "Injury Recovery Massage Therapy - 90 min", duration: 1.5, normal_price: 150, member_price: 120, staff_pay: 45, member_allowed: true, active: true },
  { id: "myo30", name: "Myotherapy-based Muscle Therapy - 30 min", duration: 0.5, normal_price: 85, member_price: 85, staff_pay: 15, member_allowed: false, active: true },
  { id: "myo45", name: "Myotherapy-based Muscle Therapy - 45 min", duration: 0.75, normal_price: 110, member_price: 110, staff_pay: 22.5, member_allowed: false, active: true },
  { id: "myo60", name: "Myotherapy-based Muscle Therapy - 60 min", duration: 1, normal_price: 125, member_price: 100, staff_pay: 30, member_allowed: true, active: true },
  { id: "myo90", name: "Myotherapy-based Muscle Therapy - 90 min", duration: 1.5, normal_price: 165, member_price: 135, staff_pay: 45, member_allowed: true, active: true },
];

const fallbackSellers = ["Zheng", "Tree", "Yuki", "Nancy", "Front Desk", "Other"];
const referralSources = ["Google", "Walk-in", "Friend Referral", "Instagram", "Facebook", "Doctor / Clinic", "Other"];

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function expiryOneYear() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function makeCardId() {
  return "YH" + Date.now().toString().slice(-8);
}

function makeServiceId() {
  return "svc_" + Date.now().toString();
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

function getAge(birthday) {
  if (!birthday) return null;
  const b = new Date(birthday);
  const t = new Date();
  let age = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
  return age;
}

function ageGroup(age) {
  if (age === null || age < 0) return "Unknown";
  if (age <= 24) return "18-24";
  if (age <= 34) return "25-34";
  if (age <= 44) return "35-44";
  if (age <= 54) return "45-54";
  return "55+";
}

function daysUntilBirthday(birthday) {
  if (!birthday) return null;
  const today = new Date();
  const b = new Date(birthday);
  let next = new Date(today.getFullYear(), b.getMonth(), b.getDate());
  today.setHours(0, 0, 0, 0);
  if (next < today) next = new Date(today.getFullYear() + 1, b.getMonth(), b.getDate());
  return Math.ceil((next - today) / (1000 * 60 * 60 * 24));
}

function normalizeService(s) {
  const normalPrice = Number(s.normal_price ?? s.price ?? 0);
  const discountType = s.discount_type || "$";
  const discountValue = Number(s.discount_value || 0);
  const calculatedMemberPrice =
    discountType === "%"
      ? Math.max(0, normalPrice * (1 - discountValue / 100))
      : Math.max(0, normalPrice - discountValue);

  return {
    id: String(s.id),
    name: s.name || "Unnamed Service",
    duration: Number(s.duration || 1),
    normal_price: normalPrice,
    discount_type: discountType,
    discount_value: discountValue,
    member_price: Number(s.member_price ?? calculatedMemberPrice),
    staff_pay: Number(s.staff_pay || 0),
    member_allowed: Boolean(s.member_allowed),
    active: s.active !== false,
  };
}

function calculateMemberPrice(normalPrice, discountType, discountValue) {
  const base = Number(normalPrice || 0);
  const discount = Number(discountValue || 0);

  if (discountType === "%") {
    return Math.max(0, base * (1 - discount / 100));
  }

  return Math.max(0, base - discount);
}

function canRedeemFirstHour(service) {
  if (!service) return false;
  return Number(service.duration || 0) >= 1;
}

function redeemFirstHourPrice(service, currentPrice) {
  const redeemValue = 100;
  return Math.max(0, Number(currentPrice || service?.normal_price || 0) - redeemValue);
}

function redeemFirstHourNote(service) {
  if (!service) return "";
  const price = Number(service.normal_price || 0);
  const duration = Number(service.duration || 0);
  const extra = Math.max(0, price - 100);

  if (duration < 1) {
    return "Redeem First Hour cannot be used for services under 60 minutes.";
  }

  if (extra === 0) {
    return "Redeem First Hour applied: $100 value fully redeemed.";
  }

  return `Redeem First Hour applied: $100 value redeemed. Customer pays extra $${money(extra)}.`;
}

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [viewMode, setViewMode] = useState("staff");
  const isOwner = viewMode === "owner";

  const [members, setMembers] = useState([]);
  const [checkouts, setCheckouts] = useState([]);
  const [deletedMembers, setDeletedMembers] = useState([]);
  const [deletedCheckouts, setDeletedCheckouts] = useState([]);
  const [services, setServices] = useState(fallbackServices);
  const [sellers, setSellers] = useState(fallbackSellers);
  const [membershipFee, setMembershipFee] = useState(100);
  const [membershipFeeInput, setMembershipFeeInput] = useState("100");
  const [sellerInput, setSellerInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [memberSearch, setMemberSearch] = useState("");
  const [checkoutSearch, setCheckoutSearch] = useState("");
  const [selectedProfileMember, setSelectedProfileMember] = useState(null);

  const [memberForm, setMemberForm] = useState({
    card_id: "",
    full_name: "",
    phone: "",
    email: "",
    birthday: "",
    suburb: "",
    gender: "",
    referral_source: "",
    sold_by: "",
    home_store: "Abbotsford",
    expiry_date: expiryOneYear(),
    payment_method: "Cash",
    notes: "",
  });

  const [checkoutForm, setCheckoutForm] = useState({
  customer: "",
  service: "",
  therapist: "",
  payment_method: "Cash",
  checkout_datetime: new Date().toISOString().slice(0,16),
});
  price_note: "",
  checkout_datetime: new Date().toISOString().slice(0, 16),
});

  const [serviceForm, setServiceForm] = useState({
    id: "",
    name: "",
    duration: 1,
    normal_price: "",
    discount_type: "$",
    discount_value: "",
    staff_pay: "",
    member_allowed: true,
    active: true,
  });

  const barcodeRef = useRef(null);

  const activeServices = useMemo(() => services.filter((s) => s.active !== false), [services]);

  function handleViewModeChange(value) {
    if (value === "owner") {
      const pin = prompt("Enter owner password");
      if (pin === OWNER_PIN) setViewMode("owner");
      else {
        alert("Wrong password");
        setViewMode("staff");
      }
    } else {
      setViewMode("staff");
    }
  }

  async function loadSettings() {
    if (!supabase) return;

    const { data: serviceData, error: serviceErr } = await supabase
      .from("service_items")
      .select("*")
      .order("name", { ascending: true });

    if (!serviceErr && serviceData?.length) {
      setServices(serviceData.map(normalizeService));
    }

    const { data: sellerData, error: sellerErr } = await supabase
      .from("sales_people")
      .select("*")
      .order("name", { ascending: true });

    if (!sellerErr && sellerData?.length) {
      setSellers(sellerData.filter((x) => x.active !== false).map((x) => x.name));
    }

    const { data: settingData, error: settingErr } = await supabase
      .from("system_settings")
      .select("*")
      .eq("key", "membership_fee")
      .maybeSingle();

    if (!settingErr && settingData?.value) {
      setMembershipFee(Number(settingData.value || 100));
      setMembershipFeeInput(String(settingData.value || "100"));
    }
  }

  async function loadData() {
    if (!supabase) return;
    setLoading(true);

    const { data: mData, error: mErr } = await supabase
      .from("members")
      .select("*")
      .eq("deleted", false)
      .order("created_at", { ascending: false });

    const { data: dmData, error: dmErr } = await supabase
      .from("members")
      .select("*")
      .eq("deleted", true)
      .order("created_at", { ascending: false });

    const { data: cData, error: cErr } = await supabase
      .from("checkouts")
      .select("*")
      .eq("deleted", false)
      .order("created_at", { ascending: false })
      .limit(1000);

    const { data: dcData, error: dcErr } = await supabase
      .from("checkouts")
      .select("*")
      .eq("deleted", true)
      .order("created_at", { ascending: false })
      .limit(1000);

    await loadSettings();

    if (mErr || cErr || dmErr || dcErr) {
      alert("Supabase loading error. Please check SQL fields.");
      console.error(mErr || cErr || dmErr || dcErr);
    } else {
      setMembers(mData || []);
      setCheckouts(cData || []);
      setDeletedMembers(dmData || []);
      setDeletedCheckouts(dcData || []);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (barcodeRef.current && memberForm.card_id) {
      try {
        JsBarcode(barcodeRef.current, memberForm.card_id, {
          format: "CODE128",
          width: 2,
          height: 60,
          displayValue: true,
        });
      } catch {}
    }
  }, [memberForm.card_id]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.toLowerCase().trim();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.full_name?.toLowerCase().includes(q) ||
        m.phone?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        m.suburb?.toLowerCase().includes(q) ||
        m.card_id?.toLowerCase().includes(q) ||
        m.sold_by?.toLowerCase().includes(q)
    );
  }, [members, memberSearch]);

  const checkoutSearchResults = useMemo(() => {
    const q = checkoutSearch.toLowerCase().trim();
    if (!q) return [];
    return members.filter(
      (m) =>
        m.full_name?.toLowerCase().includes(q) ||
        m.phone?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        m.card_id?.toLowerCase().includes(q)
    );
  }, [members, checkoutSearch]);

  const selectedService = services.find((s) => s.id === checkoutForm.service_id);
  const selectedMember = members.find((m) => m.id === checkoutForm.member_id);

  const pricePreview = useMemo(() => {
    if (!selectedService) return null;

    const isMember = Boolean(selectedMember);
    const expired = selectedMember ? new Date(selectedMember.expiry_date) < new Date(todayDate()) : false;

    let finalPrice = Number(selectedService.normal_price || 0);
    let note = "Guest / normal price applied.";

    if (isMember && !expired && selectedService.member_allowed) {
      finalPrice = Number(selectedService.member_price || selectedService.normal_price || 0);
      note = "Member price applied.";
    } else if (isMember && expired) {
      note = "Member expired. Normal price applied.";
    } else if (isMember && !selectedService.member_allowed) {
      note = "This service is not eligible for member price.";
    }

    if (checkoutForm.payment_method === "Redeem First Hour Massage") {
      if (canRedeemFirstHour(selectedService)) {
        finalPrice = redeemFirstHourPrice(selectedService, selectedService.normal_price);
        note = redeemFirstHourNote(selectedService);
      } else {
        note = redeemFirstHourNote(selectedService);
      }
    }

    const staffPay = Number(selectedService.staff_pay || 0);
    const shopProfit = finalPrice - staffPay;

    return {
      normalPrice: Number(selectedService.normal_price || 0),
      memberPrice: Number(selectedService.member_price || 0),
      finalPrice,
      staffPay,
      shopProfit,
      note,
    };
  }, [selectedService, selectedMember, checkoutForm.payment_method]);

  const existingMemberWarning = useMemo(() => {
    const phone = memberForm.phone.trim();
    const email = memberForm.email.trim().toLowerCase();
    const card = memberForm.card_id.trim().toLowerCase();

    if (!phone && !email && !card) return null;

    return members.find(
      (m) =>
        (phone && m.phone === phone) ||
        (email && m.email?.toLowerCase() === email) ||
        (card && m.card_id?.toLowerCase() === card)
    );
  }, [members, memberForm]);

  const analytics = useMemo(() => {
    const today = todayDate();
    const thisMonth = today.slice(0, 7);
    const activeMembers = members.filter((m) => new Date(m.expiry_date) >= new Date(today));
    const expiredMembers = members.filter((m) => new Date(m.expiry_date) < new Date(today));
    const newThisMonth = members.filter((m) => m.join_date?.slice(0, 7) === thisMonth);
    const todayCheckouts = checkouts.filter((c) => c.created_at?.slice(0, 10) === today);
    const monthCheckouts = checkouts.filter((c) => c.created_at?.slice(0, 7) === thisMonth);

    const groupCounts = {};
    members.forEach((m) => {
      const group = ageGroup(getAge(m.birthday));
      groupCounts[group] = (groupCounts[group] || 0) + 1;
    });

    const suburbCounts = {};
    members.forEach((m) => {
      const suburb = (m.suburb || "Unknown").trim();
      suburbCounts[suburb] = (suburbCounts[suburb] || 0) + 1;
    });

    const sellerCounts = {};
    members.forEach((m) => {
      const seller = (m.sold_by || "Not set").trim();
      sellerCounts[seller] = (sellerCounts[seller] || 0) + 1;
    });

    const therapistRevenue = {};
    const therapistCount = {};
    checkouts.forEach((c) => {
      const name = c.therapist || "Not set";
      therapistRevenue[name] = (therapistRevenue[name] || 0) + Number(c.final_price || 0);
      therapistCount[name] = (therapistCount[name] || 0) + 1;
    });

    const upcomingBirthdays = members
      .map((m) => ({ ...m, days: daysUntilBirthday(m.birthday) }))
      .filter((m) => m.days !== null && m.days <= 30)
      .sort((a, b) => a.days - b.days);

    const expiringSoon = members
      .map((m) => ({
        ...m,
        daysLeft: Math.ceil((new Date(m.expiry_date) - new Date(today)) / (1000 * 60 * 60 * 24)),
      }))
      .filter((m) => m.daysLeft >= 0 && m.daysLeft <= 30)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    return {
      totalMembers: members.length,
      activeMembers: activeMembers.length,
      expiredMembers: expiredMembers.length,
      newThisMonth: newThisMonth.length,
      todayIncome: todayCheckouts.reduce((s, x) => s + Number(x.final_price || 0), 0),
      todayStaff: todayCheckouts.reduce((s, x) => s + Number(x.staff_pay || 0), 0),
      todayProfit: todayCheckouts.reduce((s, x) => s + Number(x.shop_profit || 0), 0),
      todayCount: todayCheckouts.length,
      monthRevenue: monthCheckouts.reduce((s, x) => s + Number(x.final_price || 0), 0),
      monthProfit: monthCheckouts.reduce((s, x) => s + Number(x.shop_profit || 0), 0),
      groupCounts,
      suburbCounts,
      sellerCounts,
      therapistRevenue,
      therapistCount,
      upcomingBirthdays,
      expiringSoon,
    };
  }, [members, checkouts]);

  function pdfDataUriToBase64(dataUri) {
    return String(dataUri || "").split(",")[1] || "";
  }

  function makeMembershipReceiptPDF(member) {
    const doc = new jsPDF();

    doc.setFontSize(16);
    doc.text("YOHOME Massage & Myotherapy", 14, 16);
    doc.setFontSize(13);
    doc.text("Membership Receipt", 14, 26);

    doc.setFontSize(10);
    doc.text(`Receipt Date: ${new Date().toLocaleDateString()}`, 14, 40);
    doc.text(`Member Name: ${member.full_name || ""}`, 14, 48);
    doc.text(`Member ID: ${member.card_id || ""}`, 14, 56);
    doc.text(`Phone: ${member.phone || ""}`, 14, 64);
    doc.text(`Email: ${member.email || ""}`, 14, 72);
    doc.text(`Join Date: ${member.join_date || todayDate()}`, 14, 80);
    doc.text(`Expiry Date: ${member.expiry_date || ""}`, 14, 88);
    doc.text(`Sold By: ${member.sold_by || ""}`, 14, 96);
    doc.text(`Payment Method: ${member.payment_method || ""}`, 14, 104);
    doc.text(`Membership Fee: $${money(member.membership_fee || membershipFee)}`, 14, 112);

    autoTable(doc, {
      startY: 124,
      head: [["Item", "Amount"]],
      body: [["YOHOME 12-Month Membership", `$${money(member.membership_fee || membershipFee)}`]],
    });

    doc.setFontSize(9);
    doc.text("Thank you for purchasing a YOHOME membership.", 14, 160);
    doc.text("Please keep this receipt for your records.", 14, 167);

    return pdfDataUriToBase64(doc.output("datauristring"));
  }

  async function sendMembershipReceiptEmail(member) {
    if (!member.email) return { ok: false, skipped: true };

    const receiptPdfBase64 = makeMembershipReceiptPDF(member);

    const { data, error } = await supabase.functions.invoke("send-membership-email", {
      body: {
        member,
        receiptPdfBase64,
        termsPdfUrl: TERMS_PDF_URL,
      },
    });

    if (error) {
      console.error(error);
      return { ok: false, error };
    }

    return { ok: true, data };
  }

  async function addMember(e) {
    e.preventDefault();
    if (!supabase) return alert("Please set Supabase .env first.");
    if (!memberForm.full_name.trim()) return alert("Please enter member name.");

    if (existingMemberWarning) {
      const ok = confirm(`Possible existing member found: ${existingMemberWarning.full_name}. Continue creating new member?`);
      if (!ok) return;
    }

    const payload = {
      ...memberForm,
      card_id: memberForm.card_id.trim() || makeCardId(),
      full_name: memberForm.full_name.trim(),
      phone: memberForm.phone.trim(),
      email: memberForm.email.trim(),
      suburb: memberForm.suburb.trim(),
      join_date: todayDate(),
      membership_fee: Number(membershipFee || 100),
      status: "active",
      created_at: checkoutForm.checkout_datetime
  ? new Date(checkoutForm.checkout_datetime).toISOString()
  : new Date().toISOString(),
      deleted: false,
created_at: checkoutForm.checkout_datetime
  ? new Date(checkoutForm.checkout_datetime).toISOString()
  : new Date().toISOString(),
      receipt_sent: false,
    };

    const { data: savedMember, error } = await supabase
      .from("members")
      .insert(payload)
      .select("*")
      .single();

    if (error) return alert(error.message);

    let emailMessage = "";

    if (savedMember?.email) {
      const emailResult = await sendMembershipReceiptEmail(savedMember);

      if (emailResult.ok) {
        await supabase
          .from("members")
          .update({
            receipt_sent: true,
            receipt_sent_at: new Date().toISOString(),
          })
          .eq("id", savedMember.id);

        emailMessage = " Receipt email sent.";
      } else {
        emailMessage = " Member saved, but email was not sent. Please check Edge Function / Resend settings.";
      }
    } else {
      emailMessage = " No email address entered, so receipt email was not sent.";
    }

    setMemberForm({
      card_id: "",
      full_name: "",
      phone: "",
      email: "",
      birthday: "",
      suburb: "",
      gender: "",
      referral_source: "",
      sold_by: "",
      home_store: "Abbotsford",
      expiry_date: expiryOneYear(),
      payment_method: "Cash",
      notes: "",
    });

    await loadData();
    alert(`Member added successfully.${emailMessage}`);
  }

  async function renewMember(member) {
    const { error } = await supabase
      .from("members")
      .update({ expiry_date: expiryOneYear(), status: "active", membership_fee: Number(membershipFee || 100) })
      .eq("id", member.id);

    if (error) return alert(error.message);
    await loadData();
    alert("Membership renewed for 1 year.");
  }

  async function deleteMember(member) {
    if (!isOwner) return alert("Only owner can delete members.");
    if (!confirm(`Move ${member.full_name} to Deleted Members? You can restore it later.`)) return;

    const { error } = await supabase
      .from("members")
      .update({ deleted: true })
      .eq("id", member.id);

    if (error) return alert(error.message);
    await loadData();
  }

  async function restoreMember(member) {
    if (!isOwner) return alert("Only owner can restore members.");
    if (!confirm(`Restore member ${member.full_name}?`)) return;

    const { error } = await supabase
      .from("members")
      .update({ deleted: false })
      .eq("id", member.id);

    if (error) return alert(error.message);
    await loadData();
  }

  async function permanentDeleteMember(member) {
    if (!isOwner) return alert("Only owner can permanently delete members.");
    if (!confirm(`PERMANENTLY delete ${member.full_name}? This cannot be recovered.`)) return;

    const { error } = await supabase.from("members").delete().eq("id", member.id);
    if (error) return alert(error.message);
    await loadData();
  }

  function selectCheckoutMember(member) {
    setCheckoutForm({ ...checkoutForm, member_id: member.id });
    setCheckoutSearch(`${member.full_name} · ${member.phone || ""} · ${member.card_id}`);
  }

  async function saveCheckout(e) {
    e.preventDefault();
    if (!supabase) return alert("Please set Supabase .env first.");
    if (!selectedService || !pricePreview) return alert("Please select service.");

    const isGuest = checkoutForm.member_id === "guest";

    const payload = {
      member_id: isGuest ? null : checkoutForm.member_id,
      customer_name: isGuest ? "Guest" : selectedMember?.full_name,
      customer_type: isGuest ? "guest" : "member",
      service_name: selectedService.name,
      duration: selectedService.duration,
      original_price: pricePreview.normalPrice,
      final_price: pricePreview.finalPrice,
      staff_pay: pricePreview.staffPay,
      shop_profit: pricePreview.shopProfit,
      payment_method: checkoutForm.payment_method,
      therapist: checkoutForm.therapist,
      customer_suburb: selectedMember?.suburb || "",
      price_note: checkoutForm.price_note || pricePreview.note,
      service_price: pricePreview.finalPrice,
      deleted: false,
    };

    const { error } = await supabase.from("checkouts").insert(payload);
    if (error) return alert(error.message);

    setCheckoutForm({
  member_id: "guest",
  service_id: "",
  therapist: "",
  payment_method: "Cash",
  price_note: "",
  checkout_datetime: new Date().toISOString().slice(0, 16),
});
    setCheckoutSearch("");
    await loadData();
    alert("Checkout saved.");
  }

  async function deleteCheckout(row) {
    if (!isOwner) return alert("Only owner can delete records.");
    if (!confirm(`Move checkout record for ${row.customer_name || "customer"} to Deleted Records? You can restore it later.`)) return;

    const { error } = await supabase.from("checkouts").update({ deleted: true }).eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function restoreCheckout(row) {
    if (!isOwner) return alert("Only owner can restore records.");
    if (!confirm(`Restore checkout record for ${row.customer_name || "customer"}?`)) return;

    const { error } = await supabase.from("checkouts").update({ deleted: false }).eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function permanentDeleteCheckout(row) {
    if (!isOwner) return alert("Only owner can permanently delete records.");
    if (!confirm(`PERMANENTLY delete checkout record for ${row.customer_name || "customer"}? This cannot be recovered.`)) return;

    const { error } = await supabase.from("checkouts").delete().eq("id", row.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function saveService(e) {
    e.preventDefault();
    if (!isOwner) return alert("Only owner can manage services.");
    if (!serviceForm.name.trim()) return alert("Please enter service name.");

    const memberPrice = calculateMemberPrice(
      serviceForm.normal_price,
      serviceForm.discount_type,
      serviceForm.discount_value
    );

    const payload = {
      id: serviceForm.id || makeServiceId(),
      name: serviceForm.name.trim(),
      duration: Number(serviceForm.duration || 1),
      normal_price: Number(serviceForm.normal_price || 0),
      discount_type: serviceForm.discount_type || "$",
      discount_value: Number(serviceForm.discount_value || 0),
      member_price: memberPrice,
      staff_pay: Number(serviceForm.staff_pay || 0),
      member_allowed: Boolean(serviceForm.member_allowed),
      active: Boolean(serviceForm.active),
    };

    const { error } = await supabase.from("service_items").upsert(payload);
    if (error) return alert(error.message);

    setServiceForm({ id: "", name: "", duration: 1, normal_price: "", discount_type: "$", discount_value: "", staff_pay: "", member_allowed: true, active: true });
    await loadData();
  }

  function editService(s) {
    setServiceForm({
      id: s.id,
      name: s.name,
      duration: s.duration,
      normal_price: s.normal_price,
      discount_type: s.discount_type || "$",
      discount_value: s.discount_value || 0,
      staff_pay: s.staff_pay,
      member_allowed: s.member_allowed,
      active: s.active !== false,
    });
  }

  async function disableService(s) {
    if (!isOwner) return;
    const { error } = await supabase.from("service_items").update({ active: !s.active }).eq("id", s.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function deleteService(s) {
    if (!isOwner) return;
    if (!confirm(`Delete service: ${s.name}?`)) return;
    const { error } = await supabase.from("service_items").delete().eq("id", s.id);
    if (error) return alert(error.message);
    await loadData();
  }

  async function saveMembershipFee(e) {
    e.preventDefault();
    if (!isOwner) return;
    const value = String(Number(membershipFeeInput || 0));
    const { error } = await supabase.from("system_settings").upsert({ key: "membership_fee", value });
    if (error) return alert(error.message);
    setMembershipFee(Number(value));
    alert("Membership fee updated.");
  }

  async function addSeller(e) {
    e.preventDefault();
    if (!isOwner) return;
    const name = sellerInput.trim();
    if (!name) return;
    const { error } = await supabase.from("sales_people").upsert({ name, active: true });
    if (error) return alert(error.message);
    setSellerInput("");
    await loadData();
  }

  async function deleteSeller(name) {
    if (!isOwner) return;
    if (!confirm(`Remove seller: ${name}?`)) return;
    const { error } = await supabase.from("sales_people").delete().eq("name", name);
    if (error) return alert(error.message);
    await loadData();
  }

  function getMemberHistory(member) {
    if (!member) return [];

    return checkouts
      .filter((r) => {
        const sameMemberId = r.member_id && member.id && r.member_id === member.id;
        const sameName =
          r.customer_name &&
          member.full_name &&
          r.customer_name.toLowerCase().trim() === member.full_name.toLowerCase().trim();

        return sameMemberId || sameName;
      })
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  function getMemberStats(member) {
    const history = getMemberHistory(member);
    const totalVisits = history.length;
    const totalSpent = history.reduce((sum, r) => sum + Number(r.final_price || 0), 0);
    const lastVisit = history[0]?.created_at ? new Date(history[0].created_at).toLocaleString() : "No visits yet";

    return {
      history,
      totalVisits,
      totalSpent,
      lastVisit,
    };
  }

  function exportMemberHistoryPDF(member) {
    if (!member) return alert("Please select a member first.");

    const { history, totalVisits, totalSpent, lastVisit } = getMemberStats(member);
    const expired = new Date(member.expiry_date) < new Date(todayDate());
    const doc = new jsPDF();

    doc.setFontSize(16);
    doc.text("YOHOME Massage & Myotherapy", 14, 15);
    doc.setFontSize(13);
    doc.text("Client Treatment History", 14, 25);

    doc.setFontSize(10);
    doc.text(`Client: ${member.full_name || ""}`, 14, 38);
    doc.text(`Phone: ${member.phone || ""}`, 14, 45);
    doc.text(`Email: ${member.email || ""}`, 14, 52);
    doc.text(`Card ID: ${member.card_id || ""}`, 14, 59);
    doc.text(`Suburb: ${member.suburb || ""}`, 14, 66);
    doc.text(`Membership: ${expired ? "Expired" : "Active"}`, 14, 73);
    doc.text(`Expiry Date: ${member.expiry_date || ""}`, 14, 80);
    doc.text(`Total Visits: ${totalVisits}`, 14, 87);
    doc.text(`Total Paid: $${money(totalSpent)}`, 14, 94);
    doc.text(`Last Visit: ${lastVisit}`, 14, 101);

    autoTable(doc, {
      startY: 110,
      head: [["Date", "Service", "Therapist", "Payment", "Amount", "Note"]],
      body: history.map((r) => [
        r.created_at ? new Date(r.created_at).toLocaleString() : "",
        r.service_name || "",
        r.therapist || "",
        r.payment_method || "",
        `$${money(r.final_price)}`,
        r.price_note || "",
      ]),
      styles: { fontSize: 8 },
    });

    const safeName = (member.full_name || "Client").replace(/[^a-z0-9]/gi, "_");
    doc.save(`${safeName}_Treatment_History_${todayDate()}.pdf`);
  }

  function downloadClientUsageRecordsPDF() {
    const doc = new jsPDF();

    doc.setFontSize(16);
    doc.text("YOHOME Client Usage Records", 14, 15);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
    doc.text(`Total Records: ${checkouts.length}`, 14, 31);

    autoTable(doc, {
      startY: 40,
      head: [["Date", "Client", "Therapist", "Service", "Payment", "Amount", "Note"]],
      body: checkouts.map((r) => [
        r.created_at ? new Date(r.created_at).toLocaleString() : "",
        r.customer_name || "",
        r.therapist || "",
        r.service_name || "",
        r.payment_method || "",
        `$${money(r.final_price)}`,
        r.price_note || "",
      ]),
      styles: { fontSize: 7 },
    });

    doc.save(`YOHOME_Client_Usage_Records_${todayDate()}.pdf`);
  }

  function downloadFullBackupExcel() {
    const wb = XLSX.utils.book_new();

    const membersSheet = members.map((m) => ({
      ID: m.id,
      "Card ID": m.card_id,
      Name: m.full_name,
      Phone: m.phone,
      Email: m.email,
      Birthday: m.birthday,
      Suburb: m.suburb,
      Gender: m.gender,
      "Referral Source": m.referral_source,
      "Sold By": m.sold_by,
      "Membership Fee": m.membership_fee,
      "Join Date": m.join_date,
      "Expiry Date": m.expiry_date,
      Status: m.status,
      Notes: m.notes,
      Created: m.created_at,
    }));

    const checkoutsSheet = checkouts.map((r) => ({
      ID: r.id,
      "Member ID": r.member_id,
      Client: r.customer_name,
      "Customer Type": r.customer_type,
      Service: r.service_name,
      Duration: r.duration,
      "Original Price": r.original_price,
      "Final Price": r.final_price,
      "Staff Pay": r.staff_pay,
      Profit: r.shop_profit,
      Payment: r.payment_method,
      Therapist: r.therapist,
      Suburb: r.customer_suburb,
      Note: r.price_note,
      Created: r.created_at,
    }));

    const servicesSheet = services.map((s) => ({
      ID: s.id,
      Service: s.name,
      Duration: s.duration,
      "Normal Price": s.normal_price,
      "Discount Type": s.discount_type,
      "Discount Value": s.discount_value,
      "Member Price": s.member_price,
      "Staff Pay": s.staff_pay,
      "Member Allowed": s.member_allowed,
      Active: s.active,
    }));

    const sellersSheet = sellers.map((name) => ({ Name: name }));
    const settingsSheet = [{ Key: "membership_fee", Value: membershipFee }];

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(membersSheet), "Members");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(checkoutsSheet), "Checkouts");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(servicesSheet), "Services");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sellersSheet), "Sellers");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(settingsSheet), "Settings");

    XLSX.writeFile(wb, `YOHOME_FULL_BACKUP_${todayDate()}.xlsx`);
  }

  function downloadMembersExcel() {
    const data = members.map((m) => ({
      "Card ID": m.card_id,
      Name: m.full_name,
      Phone: m.phone,
      Email: m.email,
      Birthday: m.birthday,
      Age: getAge(m.birthday) || "",
      Suburb: m.suburb,
      Gender: m.gender,
      "Referral Source": m.referral_source,
      "Sold By": m.sold_by,
      "Membership Fee": m.membership_fee,
      "Join Date": m.join_date,
      "Expiry Date": m.expiry_date,
      Status: new Date(m.expiry_date) >= new Date(todayDate()) ? "Active" : "Expired",
      Notes: m.notes,
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Members");
    XLSX.writeFile(wb, `YOHOME_Members_${todayDate()}.xlsx`);
  }

  function downloadCRMExcel() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(analytics.groupCounts).map(([AgeGroup, Members]) => ({ AgeGroup, Members }))), "Age Groups");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(analytics.suburbCounts).map(([Suburb, Members]) => ({ Suburb, Members }))), "Suburbs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(analytics.sellerCounts).map(([Seller, CardsSold]) => ({ Seller, CardsSold }))), "Seller Performance");
    XLSX.writeFile(wb, `YOHOME_CRM_Analytics_${todayDate()}.xlsx`);
  }

  function downloadIncomePDF() {
    const doc = new jsPDF();
    const totalIncome = checkouts.reduce((s, x) => s + Number(x.final_price || 0), 0);
    const totalStaff = checkouts.reduce((s, x) => s + Number(x.staff_pay || 0), 0);
    const totalProfit = checkouts.reduce((s, x) => s + Number(x.shop_profit || 0), 0);

    doc.text("YOHOME Income Report", 14, 15);
    doc.text(`Total Income: $${money(totalIncome)}`, 14, 25);
    doc.text(`Staff Pay: $${money(totalStaff)}`, 14, 33);
    doc.text(`Shop Profit: $${money(totalProfit)}`, 14, 41);

    autoTable(doc, {
      startY: 50,
      head: [["Date", "Customer", "Service", "Therapist", "Income", "Staff", "Profit", "Payment"]],
      body: checkouts.map((r) => [
        r.created_at ? new Date(r.created_at).toLocaleString() : "",
        r.customer_name || "",
        r.service_name || "",
        r.therapist || "",
        `$${money(r.final_price)}`,
        `$${money(r.staff_pay)}`,
        `$${money(r.shop_profit)}`,
        r.payment_method || "",
      ]),
    });

    doc.save(`YOHOME_Income_Report_${todayDate()}.pdf`);
  }

  function downloadMembersPDF() {
    const doc = new jsPDF();
    doc.text("YOHOME Membership List", 14, 15);
    autoTable(doc, {
      startY: 22,
      head: [["Card", "Name", "Phone", "Email", "Suburb", "Sold By", "Join", "Expiry"]],
      body: members.map((m) => [m.card_id || "", m.full_name || "", m.phone || "", m.email || "", m.suburb || "", m.sold_by || "", m.join_date || "", m.expiry_date || ""]),
    });
    doc.save(`YOHOME_Members_${todayDate()}.pdf`);
  }

  const menu = isOwner
    ? ["dashboard", "members", "checkout", "services", "staff", "analytics", "reports", "settings"]
    : ["dashboard", "members", "checkout"];

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>YOHOME</h1>
        <p>Membership CRM</p>

        <div className="modeBox">
          <span>Current View</span>
          <select value={viewMode} onChange={(e) => handleViewModeChange(e.target.value)}>
            <option value="staff">Staff View</option>
            <option value="owner">Owner View</option>
          </select>
        </div>

        {menu.map((x) => (
          <button key={x} onClick={() => setTab(x)} className={tab === x ? "active" : ""}>
            {x.charAt(0).toUpperCase() + x.slice(1)}
          </button>
        ))}

        <div className="side-note">{supabase ? "Cloud database connected" : "Supabase not connected yet"}</div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h2>{tab.toUpperCase()}</h2>
            <span>{isOwner ? "Owner view: full finance and settings" : "Staff view: prices only, profit hidden"}</span>
          </div>
          <button onClick={loadData}>Refresh</button>
        </div>

        {loading && <div className="notice">Loading...</div>}

        {tab === "dashboard" && (
          <>
            <div className="cards">
              <Card title="Total Members" value={analytics.totalMembers} />
              <Card title="Active Members" value={analytics.activeMembers} />
              <Card title="Expired Members" value={analytics.expiredMembers} />
              <Card title="Today Checkouts" value={analytics.todayCount} />
              {isOwner && <Card title="Today Income" value={`$${money(analytics.todayIncome)}`} />}
              {isOwner && <Card title="Today Profit" value={`$${money(analytics.todayProfit)}`} />}
              {isOwner && <Card title="Monthly Revenue" value={`$${money(analytics.monthRevenue)}`} />}
              {isOwner && <Card title="Monthly Profit" value={`$${money(analytics.monthProfit)}`} />}
            </div>

            <div className="grid-two">
              <MiniPanel title="Upcoming Birthdays">
                {analytics.upcomingBirthdays.length ? analytics.upcomingBirthdays.map((m) => <p key={m.id}>{m.full_name} · {m.birthday} · {m.days} days</p>) : <p>No birthdays in 30 days.</p>}
              </MiniPanel>
              <MiniPanel title="Expiring Soon">
                {analytics.expiringSoon.length ? analytics.expiringSoon.map((m) => <p key={m.id}>{m.full_name} · expires in {m.daysLeft} days</p>) : <p>No memberships expiring soon.</p>}
              </MiniPanel>
            </div>
          </>
        )}

        {tab === "members" && (
          <div className="grid-two">
            <section className="panel">
              <h3>Register New Member</h3>
              <form onSubmit={addMember} className="form">
                <label>Card ID</label>
                <input placeholder="Leave blank for auto ID" value={memberForm.card_id} onChange={(e) => setMemberForm({ ...memberForm, card_id: e.target.value })} />
                <label>Full Name</label>
                <input value={memberForm.full_name} onChange={(e) => setMemberForm({ ...memberForm, full_name: e.target.value })} />
                <label>Phone</label>
                <input value={memberForm.phone} onChange={(e) => setMemberForm({ ...memberForm, phone: e.target.value })} />
                <label>Email</label>
                <input value={memberForm.email} onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })} />
                <label>Date of Birth</label>
                <input type="date" value={memberForm.birthday} onChange={(e) => setMemberForm({ ...memberForm, birthday: e.target.value })} />
                <label>Suburb / Area</label>
                <input placeholder="e.g. Abbotsford, Richmond, Kew" value={memberForm.suburb} onChange={(e) => setMemberForm({ ...memberForm, suburb: e.target.value })} />
                <label>Gender</label>
                <select value={memberForm.gender} onChange={(e) => setMemberForm({ ...memberForm, gender: e.target.value })}>
                  <option value="">Prefer not to say</option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Other</option>
                </select>
                <label>Service Date / Time</label>
<input
  type="datetime-local"
  value={checkoutForm.checkout_datetime}
  onChange={(e) =>
    setCheckoutForm({
      ...checkoutForm,
      checkout_datetime: e.target.value,
    })
  }
/>
                <label>Referral Source</label>
                <select value={memberForm.referral_source} onChange={(e) => setMemberForm({ ...memberForm, referral_source: e.target.value })}>
                  <option value="">Select</option>
                  {referralSources.map((x) => <option key={x}>{x}</option>)}
                </select>
                <label>Sold By / Card Seller</label>
                <select value={memberForm.sold_by} onChange={(e) => setMemberForm({ ...memberForm, sold_by: e.target.value })}>
                  <option value="">Select seller</option>
                  {sellers.map((x) => <option key={x}>{x}</option>)}
                </select>
                <label>Expiry Date</label>
                <input type="date" value={memberForm.expiry_date} onChange={(e) => setMemberForm({ ...memberForm, expiry_date: e.target.value })} />
                <label>Payment Method</label>
                <select value={memberForm.payment_method} onChange={(e) => setMemberForm({ ...memberForm, payment_method: e.target.value })}>
                  <option>Cash</option>
                  <option>Card</option>
                  <option>Bank Transfer</option>
                </select>
                <label>Notes</label>
                <textarea value={memberForm.notes} onChange={(e) => setMemberForm({ ...memberForm, notes: e.target.value })} />
                {existingMemberWarning && <div className="warningBox">Possible existing member: {existingMemberWarning.full_name} · {existingMemberWarning.phone} · {existingMemberWarning.card_id}</div>}
                <button className="primary">Save Member & Send Receipt - ${money(membershipFee)}</button>
              </form>
              {memberForm.card_id && <div className="barcodeBox"><svg ref={barcodeRef}></svg></div>}
            </section>

            <section className="panel">
              <h3>Member Search</h3>
              <input className="search" placeholder="Search name / phone / email / suburb / card ID / seller" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} />
              <div className="memberList">
                {filteredMembers.map((m) => {
                  const expired = new Date(m.expiry_date) < new Date(todayDate());
                  return (
                    <div className="memberItem" key={m.id}>
                      <div>
                        <strong>{m.full_name}</strong>
                        <p>{m.phone || "No phone"} · {m.email || "No email"} · {m.card_id}</p>
                        <p>{m.suburb || "No suburb"} · Sold by: {m.sold_by || "-"} · Expiry: {m.expiry_date} <span className={expired ? "badge bad" : "badge good"}>{expired ? "Expired" : "Active"}</span></p>
                      </div>
                      <div className="rowBtns">
                        <button onClick={() => setSelectedProfileMember(m)}>View Profile</button>
                        <button onClick={() => exportMemberHistoryPDF(m)}>Export PDF</button>
                        <button onClick={() => renewMember(m)}>Renew</button>
                        {isOwner && <button className="danger" onClick={() => deleteMember(m)}>Delete</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

           <section className="panel profilePanel">
  <h3>Member Profile & Treatment History</h3>
              <MemberProfile
                member={selectedProfileMember}
                history={getMemberHistory(selectedProfileMember)}
                stats={getMemberStats(selectedProfileMember)}
                onExportPDF={exportMemberHistoryPDF}
              />
            </section>
          </div>
        )}

        {tab === "checkout" && (
          <div className="grid-two">
            <section className="panel">
              <h3>Service Checkout</h3>
              <label>Search Member</label>
              <input className="search" placeholder="Phone / Card ID / Name / Email" value={checkoutSearch} onChange={(e) => setCheckoutSearch(e.target.value)} />
              {checkoutSearchResults.length > 0 && (
                <div className="searchDropdown">
                  {checkoutSearchResults.map((m) => <div key={m.id} onClick={() => selectCheckoutMember(m)}>{m.full_name} · {m.phone || "No phone"} · {m.card_id}</div>)}
                </div>
              )}
              <form onSubmit={saveCheckout} className="form">
                <label>Customer</label>
                <select value={checkoutForm.member_id} onChange={(e) => setCheckoutForm({ ...checkoutForm, member_id: e.target.value })}>
                  <option value="guest">Guest</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.full_name} · {m.phone || ""} · {m.card_id}</option>)}
                </select>
                <label>Service</label>
                <select value={checkoutForm.service_id} onChange={(e) => setCheckoutForm({ ...checkoutForm, service_id: e.target.value })}>
                  <option value="">Select service</option>
                  {activeServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <label>Therapist</label>
<select value={checkoutForm.therapist} onChange={(e) => setCheckoutForm({ ...checkoutForm, therapist: e.target.value })}>
  <option value="">Select</option>
  {sellers.map((x) => <option key={x}>{x}</option>)}
</select>

<label>Service Date / Time</label>
<input
  type="datetime-local"
  value={checkoutForm.checkout_datetime}
  onChange={(e) =>
    setCheckoutForm({
      ...checkoutForm,
      checkout_datetime: e.target.value,
    })
  }
/>

                <label>Service Date / Time</label>
<input
  type="datetime-local"
  value={checkoutForm.checkout_datetime || ""}
  onChange={(e) =>
    setCheckoutForm({
      ...checkoutForm,
      checkout_datetime: e.target.value,
    })
  }
/>
                <label>Payment</label>
                <select value={checkoutForm.payment_method} onChange={(e) => setCheckoutForm({ ...checkoutForm, payment_method: e.target.value })}>
                  <option>Cash</option>
                  <option>Card</option>
                  <option>Bank Transfer</option>
                  <option>Redeem First Hour Massage</option>
                </select>
                {isOwner && (
                  <>
                    <label>Owner Note</label>
                    <input value={checkoutForm.price_note} onChange={(e) => setCheckoutForm({ ...checkoutForm, price_note: e.target.value })} />
                  </>
                )}
                {pricePreview && (
                  <div className="priceBox">
                    {isOwner && <p>Normal Price: ${money(pricePreview.normalPrice)}</p>}
                    {isOwner && <p>Member Price: ${money(pricePreview.memberPrice)}</p>}
                    <p>Final Price: ${money(pricePreview.finalPrice)}</p>
                    {isOwner && <><p>Staff Pay: ${money(pricePreview.staffPay)}</p><p>Profit: ${money(pricePreview.shopProfit)}</p></>}
                    <strong>{pricePreview.note}</strong>
                  </div>
                )}
                <button
                  className="primary"
                  disabled={
                    checkoutForm.payment_method === "Redeem First Hour Massage" &&
                    selectedService &&
                    !canRedeemFirstHour(selectedService)
                  }
                >
                  Confirm Checkout
                </button>
              </form>
            </section>
            <section className="panel">
              <h3>Latest Records</h3>
              <TableCheckouts rows={checkouts.slice(0, 20)} isOwner={isOwner} onDelete={deleteCheckout} />
            </section>
          </div>
        )}

        {tab === "services" && isOwner && (
          <div className="grid-two">
            <section className="panel">
              <h3>Service Management</h3>
              <form onSubmit={saveService} className="form">
                <label>Service Name</label>
                <input value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} />
                <label>Duration / Hours</label>
                <input type="number" step="0.25" value={serviceForm.duration} onChange={(e) => setServiceForm({ ...serviceForm, duration: e.target.value })} />
                <label>Normal Price</label>
                <input type="number" value={serviceForm.normal_price} onChange={(e) => setServiceForm({ ...serviceForm, normal_price: e.target.value })} />
                <label>Discount Type</label>
                <select value={serviceForm.discount_type} onChange={(e) => setServiceForm({ ...serviceForm, discount_type: e.target.value })}>
                  <option value="$">$ Discount Price</option>
                  <option value="%">% Discount Rate</option>
                </select>

                <label>{serviceForm.discount_type === "%" ? "Discount Rate (%)" : "Discount Price ($)"}</label>
                <input type="number" value={serviceForm.discount_value} onChange={(e) => setServiceForm({ ...serviceForm, discount_value: e.target.value })} />

                <label>Member Price Auto Calculated</label>
                <input type="number" value={money(calculateMemberPrice(serviceForm.normal_price, serviceForm.discount_type, serviceForm.discount_value))} readOnly />
                <label>Staff Pay</label>
                <input type="number" value={serviceForm.staff_pay} onChange={(e) => setServiceForm({ ...serviceForm, staff_pay: e.target.value })} />
                <label>Member Price Allowed?</label>
                <select value={String(serviceForm.member_allowed)} onChange={(e) => setServiceForm({ ...serviceForm, member_allowed: e.target.value === "true" })}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
                <label>Status</label>
                <select value={String(serviceForm.active)} onChange={(e) => setServiceForm({ ...serviceForm, active: e.target.value === "true" })}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
                <button className="primary">{serviceForm.id ? "Update Service" : "Add Service"}</button>
              </form>
            </section>
            <section className="panel">
              <h3>Current Services</h3>
              <ServiceTable services={services} onEdit={editService} onToggle={disableService} onDelete={deleteService} />
            </section>
          </div>
        )}

        {tab === "settings" && isOwner && (
          <div className="grid-two">
            <section className="panel">
              <h3>Membership Fee Setting</h3>
              <form onSubmit={saveMembershipFee} className="form">
                <label>Current Membership Fee</label>
                <input type="number" value={membershipFeeInput} onChange={(e) => setMembershipFeeInput(e.target.value)} />
                <button className="primary">Save Membership Fee</button>
              </form>
            </section>
            <section className="panel">
              <h3>Seller / Therapist Names</h3>
              <form onSubmit={addSeller} className="form">
                <label>Add Name</label>
                <input value={sellerInput} onChange={(e) => setSellerInput(e.target.value)} placeholder="e.g. Cedrick, Nice" />
                <button className="primary">Add Name</button>
              </form>
              <div className="memberList">
                {sellers.map((name) => <div className="memberItem" key={name}><strong>{name}</strong><div className="rowBtns"><button className="danger" onClick={() => deleteSeller(name)}>Delete</button></div></div>)}
              </div>
            </section>

            <section className="panel">
              <h3>Deleted Members</h3>
              <DeletedMembersTable rows={deletedMembers} onRestore={restoreMember} onPermanentDelete={permanentDeleteMember} />
            </section>

            <section className="panel">
              <h3>Deleted Checkout Records</h3>
              <DeletedCheckoutsTable rows={deletedCheckouts} onRestore={restoreCheckout} onPermanentDelete={permanentDeleteCheckout} />
            </section>
          </div>
        )}

        {tab === "staff" && isOwner && (
          <div className="grid-two">
            <MiniPanel title="Therapist Performance">
              <SimpleTable data={Object.entries(analytics.therapistRevenue).map(([k, v]) => [k, analytics.therapistCount[k] || 0, `$${money(v)}`])} headers={["Therapist", "Checkouts", "Revenue"]} />
            </MiniPanel>
            <MiniPanel title="Membership Sold By">
              <SimpleTable data={Object.entries(analytics.sellerCounts)} headers={["Seller", "Cards Sold"]} />
            </MiniPanel>
          </div>
        )}

        {tab === "analytics" && isOwner && (
          <div className="grid-two">
            <MiniPanel title="Age Group Analysis"><SimpleTable data={Object.entries(analytics.groupCounts)} headers={["Age Group", "Members"]} /></MiniPanel>
            <MiniPanel title="Suburb / Area Analysis"><SimpleTable data={Object.entries(analytics.suburbCounts)} headers={["Suburb", "Members"]} /></MiniPanel>
            <MiniPanel title="Membership Sold By"><SimpleTable data={Object.entries(analytics.sellerCounts)} headers={["Seller", "Cards Sold"]} /></MiniPanel>
            <MiniPanel title="Upcoming Birthdays"><SimpleTable data={analytics.upcomingBirthdays.map((m) => [m.full_name, m.birthday, `${m.days} days`])} headers={["Name", "Birthday", "Remaining"]} /></MiniPanel>
          </div>
        )}

        {tab === "reports" && isOwner && (
          <section className="panel">
            <h3>Reports & Backup</h3>
            <div className="exportBtns">
              <button onClick={downloadMembersExcel}>Download Members Excel</button>
              <button onClick={downloadMembersPDF}>Download Members PDF</button>
              <button onClick={downloadCRMExcel}>Download CRM Excel</button>
              <button onClick={downloadIncomePDF}>Download Income Report PDF</button>
              <button onClick={downloadClientUsageRecordsPDF}>Download Client Usage PDF</button>
              <button onClick={downloadFullBackupExcel}>Download Full Backup Excel</button>
            </div>
            <TableCheckouts rows={checkouts} isOwner={isOwner} onDelete={deleteCheckout} />
          </section>
        )}
      </main>
    </div>
  );
}

function Card({ title, value }) {
  return <div className="card"><span>{title}</span><strong>{value}</strong></div>;
}

function MiniPanel({ title, children }) {
  return <section className="panel"><h3>{title}</h3>{children}</section>;
}

function SimpleTable({ data, headers }) {
  if (!data?.length) return <p className="empty">No data yet.</p>;
  return (
    <div className="tableWrap">
      <table>
        <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{data.map((row, i) => <tr key={i}>{row.map((x, j) => <td key={j}>{x}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function ServiceTable({ services, onEdit, onToggle, onDelete }) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr><th>Service</th><th>Hours</th><th>Normal</th><th>Discount</th><th>Member</th><th>Staff</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.duration}</td>
              <td>${money(s.normal_price)}</td>
              <td>{s.discount_type === "%" ? `${money(s.discount_value)}%` : `$${money(s.discount_value)}`}</td>
              <td>${money(s.member_price)}</td>
              <td>${money(s.staff_pay)}</td>
              <td>{s.active ? "Active" : "Inactive"}</td>
              <td className="rowBtns"><button onClick={() => onEdit(s)}>Edit</button><button onClick={() => onToggle(s)}>{s.active ? "Disable" : "Enable"}</button><button className="danger" onClick={() => onDelete(s)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}



function MemberProfile({ member, history, stats, onExportPDF }) {
  if (!member) {
    return <p className="empty">Select a member and click View Profile to see treatment history.</p>;
  }

  const expired = new Date(member.expiry_date) < new Date(todayDate());

  return (
    <div className="profilePage">
      <div className="profileHero">
        <div className="profileAvatar">👤</div>

        <div className="profileDetails">
          <h2>{member.full_name}</h2>

          <div className="profileInfoGrid">
            <span>☎ {member.phone || "No phone"}</span>
            <span>✉ {member.email || "No email"}</span>
            <span>▣ {member.card_id}</span>
            <span>⌖ {member.suburb || "No suburb"}</span>
            <span>Sold by: {member.sold_by || "-"}</span>
          </div>

          <div className="profileMembershipLine">
            <span>Membership:</span>
            <span className={expired ? "badge bad" : "badge good"}>{expired ? "Expired" : "Active"}</span>
            <span>Expires: {member.expiry_date || ""}</span>
          </div>
        </div>
      </div>

      <div className="profileStatGrid">
        <div className="profileStatCard">
          <div className="profileStatIcon">👥</div>
          <div>
            <span>Total Visits</span>
            <strong>{stats.totalVisits}</strong>
          </div>
        </div>

        <div className="profileStatCard">
          <div className="profileStatIcon">$</div>
          <div>
            <span>Total Spent</span>
            <strong>${money(stats.totalSpent)}</strong>
          </div>
        </div>

        <div className="profileStatCard">
          <div className="profileStatIcon">📅</div>
          <div>
            <span>Last Visit</span>
            <strong>{stats.lastVisit}</strong>
          </div>
        </div>
      </div>

      <div className="exportBtns profileExportBtns">
        <button onClick={() => onExportPDF?.(member)}>Export Client History PDF</button>
      </div>

      <div className="redeemInfoBox">
        <div>
          <strong>Redeem First Hour Massage</strong>
          <p>$100 redeemable value for one 60-minute session. Services under 60 minutes cannot use this benefit.</p>
          <ul>
            <li>60 min $100 service → $0</li>
            <li>60 min $110 service → customer pays $10</li>
            <li>90 min $150 service → customer pays $50</li>
          </ul>
        </div>
        <div className="redeemValueCard">
          <span>Redeemable Value</span>
          <strong>$100</strong>
          <small>One-time use only</small>
        </div>
      </div>

      <div className="historyPanel">
        <h3>Treatment History</h3>
        <TreatmentHistoryTable rows={history} />
      </div>
    </div>
  );
}

function TreatmentHistoryTable({ rows }) {
  if (!rows?.length) return <p className="empty">No treatment history yet.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Service</th>
            <th>Therapist</th>
            <th>Payment</th>
            <th>Amount</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
              <td>{r.service_name || ""}</td>
              <td>{r.therapist || ""}</td>
              <td><span className="paymentPill">{r.payment_method || ""}</span></td>
              <td>${money(r.final_price)}</td>
              <td>{r.price_note || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function DeletedMembersTable({ rows, onRestore, onPermanentDelete }) {
  if (!rows?.length) return <p className="empty">No deleted members.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Card ID</th>
            <th>Expiry</th>
            <th>Sold By</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.full_name}</td>
              <td>{m.phone || ""}</td>
              <td>{m.card_id || ""}</td>
              <td>{m.expiry_date || ""}</td>
              <td>{m.sold_by || ""}</td>
              <td className="rowBtns">
                <button onClick={() => onRestore?.(m)}>Restore</button>
                <button className="danger" onClick={() => onPermanentDelete?.(m)}>Permanent Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeletedCheckoutsTable({ rows, onRestore, onPermanentDelete }) {
  if (!rows?.length) return <p className="empty">No deleted checkout records.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Therapist</th>
            <th>Service</th>
            <th>Price</th>
            <th>Payment</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
              <td>{r.customer_name || ""}</td>
              <td>{r.therapist || ""}</td>
              <td>{r.service_name || ""}</td>
              <td>${money(r.final_price)}</td>
              <td>{r.payment_method || ""}</td>
              <td className="rowBtns">
                <button onClick={() => onRestore?.(r)}>Restore</button>
                <button className="danger" onClick={() => onPermanentDelete?.(r)}>Permanent Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function TableCheckouts({ rows, isOwner, onDelete }) {
  if (!rows?.length) return <p className="empty">No records yet.</p>;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Name</th><th>Therapist</th><th>Service</th><th>Price</th>
            {isOwner && <><th>Staff</th><th>Profit</th><th>Payment</th><th>Note</th><th>Action</th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
              <td>{r.customer_name}</td>
              <td>{r.therapist || ""}</td>
              <td>{r.service_name}</td>
              <td>${money(r.final_price)}</td>
              {isOwner && <><td>${money(r.staff_pay)}</td><td>${money(r.shop_profit)}</td><td>{r.payment_method || ""}</td><td>{r.price_note || ""}</td><td><button className="danger" onClick={() => onDelete?.(r)}>Delete</button></td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
