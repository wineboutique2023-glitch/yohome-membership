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

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const STAFF_HOUR = 30;
const MEMBER_HOUR = 80;
const YEAR_FEE = 100;

const services = [
  { id: "deep30", name: "Pain Relief Deep Tissue Therapy - 30 min", duration: 0.5, price: 50, memberAllowed: false },
  { id: "deep45", name: "Pain Relief Deep Tissue Therapy - 45 min", duration: 0.75, price: 75, memberAllowed: false },
  { id: "deep60", name: "Pain Relief Deep Tissue Therapy - 60 min", duration: 1, price: 100, memberAllowed: true },
  { id: "deep90", name: "Pain Relief Deep Tissue Therapy - 90 min", duration: 1.5, price: 150, memberAllowed: true },

  { id: "injury30", name: "Injury Recovery Massage Therapy - 30 min", duration: 0.5, price: 60, memberAllowed: false },
  { id: "injury45", name: "Injury Recovery Massage Therapy - 45 min", duration: 0.75, price: 80, memberAllowed: false },
  { id: "injury60", name: "Injury Recovery Massage Therapy - 60 min", duration: 1, price: 110, memberAllowed: true },
  { id: "injury90", name: "Injury Recovery Massage Therapy - 90 min", duration: 1.5, price: 150, memberAllowed: true },

  { id: "myo30", name: "Myotherapy-based Muscle Therapy - 30 min", duration: 0.5, price: 85, memberAllowed: false },
  { id: "myo45", name: "Myotherapy-based Muscle Therapy - 45 min", duration: 0.75, price: 110, memberAllowed: false },
  { id: "myo60", name: "Myotherapy-based Muscle Therapy - 60 min", duration: 1, price: 125, memberAllowed: true },
  { id: "myo90", name: "Myotherapy-based Muscle Therapy - 90 min", duration: 1.5, price: 165, memberAllowed: true },
];

function expiryOneYear() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function makeCardId() {
  return "YH" + Date.now().toString().slice(-8);
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [viewMode, setViewMode] = useState("staff");
  const isOwner = viewMode === "owner";

  const [members, setMembers] = useState([]);
  const [checkouts, setCheckouts] = useState([]);
  const [loading, setLoading] = useState(false);

  const [memberSearch, setMemberSearch] = useState("");
  const [checkoutSearch, setCheckoutSearch] = useState("");

  const [memberForm, setMemberForm] = useState({
    card_id: "",
    full_name: "",
    phone: "",
    email: "",
    expiry_date: expiryOneYear(),
    payment_method: "Cash",
    notes: "",
  });

  const [checkoutForm, setCheckoutForm] = useState({
    member_id: "guest",
    service_id: "",
    payment_method: "Cash",
    manual_price: "",
    discount_amount: 0,
    price_note: "",
  });

  const barcodeRef = useRef(null);

  function handleViewModeChange(value) {
    if (value === "owner") {
      const pin = prompt("Enter owner password");
      if (pin === OWNER_PIN) {
        setViewMode("owner");
      } else {
        alert("Wrong password");
        setViewMode("staff");
      }
    } else {
      setViewMode("staff");
    }
  }

  async function loadData() {
    if (!supabase) return;
    setLoading(true);

    const { data: mData, error: mErr } = await supabase
      .from("members")
      .select("*")
      .order("created_at", { ascending: false });

    const { data: cData, error: cErr } = await supabase
      .from("checkouts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);

    if (mErr || cErr) {
      alert("Supabase loading error. Please check your SQL table and .env.");
      console.error(mErr || cErr);
    } else {
      setMembers(mData || []);
      setCheckouts(cData || []);
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
        m.card_id?.toLowerCase().includes(q)
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

  const existingMemberWarning = useMemo(() => {
    const phone = memberForm.phone.trim();
    const card = memberForm.card_id.trim();
    const email = memberForm.email.trim().toLowerCase();

    if (!phone && !card && !email) return null;

    return members.find(
      (m) =>
        (phone && m.phone === phone) ||
        (email && m.email?.toLowerCase() === email) ||
        (card && m.card_id?.toLowerCase() === card.toLowerCase())
    );
  }, [members, memberForm.phone, memberForm.card_id, memberForm.email]);

  const selectedService = services.find((s) => s.id === checkoutForm.service_id);
  const selectedMember = members.find((m) => m.id === checkoutForm.member_id);
    const pricePreview = useMemo(() => {
    if (!selectedService) return null;

    const isMember = Boolean(selectedMember);
    const expired = selectedMember
      ? new Date(selectedMember.expiry_date) < new Date(todayDate())
      : false;

    let basePrice = selectedService.price;
    let note = "Guest / normal price applied.";

    if (isMember && !expired && selectedService.memberAllowed) {
      basePrice = selectedService.duration * MEMBER_HOUR;
      note = "Member price applied.";
    } else if (isMember && expired) {
      note = "Member expired. Normal price applied.";
    } else if (isMember && !selectedService.memberAllowed) {
      note = "Member price only applies to 60 min or longer services.";
    }

    let finalPrice = basePrice;
    let priceOverride = false;

    if (isOwner && checkoutForm.manual_price !== "") {
      finalPrice = Number(checkoutForm.manual_price || 0);
      priceOverride = true;
      note = "Owner manual price applied.";
    }

    const discount = Number(checkoutForm.discount_amount || 0);
    if (isOwner && discount > 0 && checkoutForm.manual_price === "") {
      finalPrice = Math.max(0, basePrice - discount);
      priceOverride = true;
      note = "Owner discount applied.";
    }

    const staffPay = selectedService.duration * STAFF_HOUR;
    const shopProfit = finalPrice - staffPay;

    return {
      originalPrice: selectedService.price,
      basePrice,
      finalPrice,
      staffPay,
      shopProfit,
      discount,
      priceOverride,
      note,
    };
  }, [selectedService, selectedMember, checkoutForm, isOwner]);

  const todayStats = useMemo(() => {
    const today = todayDate();
    const list = checkouts.filter((c) => c.created_at?.slice(0, 10) === today);

    return {
      income: list.reduce((s, x) => s + Number(x.final_price || 0), 0),
      staff: list.reduce((s, x) => s + Number(x.staff_pay || 0), 0),
      profit: list.reduce((s, x) => s + Number(x.shop_profit || 0), 0),
      count: list.length,
    };
  }, [checkouts]);

  async function addMember(e) {
    e.preventDefault();

    if (!supabase) return alert("Please set Supabase .env first.");
    if (!memberForm.full_name.trim()) return alert("Please enter member name.");

    if (existingMemberWarning) {
      const ok = confirm(
        `Possible existing member found: ${existingMemberWarning.full_name}. Continue creating new member?`
      );
      if (!ok) return;
    }

    const cardId = memberForm.card_id.trim() || makeCardId();

    const payload = {
      card_id: cardId,
      full_name: memberForm.full_name.trim(),
      phone: memberForm.phone.trim(),
      email: memberForm.email.trim(),
      join_date: todayDate(),
      expiry_date: memberForm.expiry_date || expiryOneYear(),
      membership_fee: YEAR_FEE,
      payment_method: memberForm.payment_method,
      status: "active",
      notes: memberForm.notes,
    };

    const { error } = await supabase.from("members").insert(payload);

    if (error) {
      alert(error.message);
      return;
    }

    setMemberForm({
      card_id: "",
      full_name: "",
      phone: "",
      email: "",
      expiry_date: expiryOneYear(),
      payment_method: "Cash",
      notes: "",
    });

    await loadData();
    alert("Member added successfully.");
  }

  async function renewMember(member) {
    const newExpiry = expiryOneYear();

    const { error } = await supabase
      .from("members")
      .update({
        expiry_date: newExpiry,
        status: "active",
        membership_fee: YEAR_FEE,
      })
      .eq("id", member.id);

    if (error) return alert(error.message);

    await loadData();
    alert("Membership renewed for 1 year.");
  }

  async function deleteMember(member) {
    if (!isOwner) return alert("Only owner can delete members.");
    if (!confirm(`Delete member ${member.full_name}?`)) return;

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
      original_price: pricePreview.originalPrice,
      final_price: pricePreview.finalPrice,
      staff_pay: pricePreview.staffPay,
      shop_profit: pricePreview.shopProfit,
      payment_method: checkoutForm.payment_method,
      discount_amount: isOwner ? pricePreview.discount : 0,
      price_override: isOwner ? pricePreview.priceOverride : false,
      price_note: isOwner ? checkoutForm.price_note : "",
    };

    const { error } = await supabase.from("checkouts").insert(payload);

    if (error) {
      alert(error.message);
      return;
    }

    setCheckoutForm({
      member_id: "guest",
      service_id: "",
      payment_method: "Cash",
      manual_price: "",
      discount_amount: 0,
      price_note: "",
    });
    setCheckoutSearch("");

    await loadData();
    alert("Checkout saved.");
  }

  function downloadMembersExcel() {
    const data = members.map((m) => ({
      "Card ID": m.card_id,
      Name: m.full_name,
      Phone: m.phone,
      Email: m.email,
      "Join Date": m.join_date,
      "Expiry Date": m.expiry_date,
      Status: m.status,
      Notes: m.notes,
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, ws, "Members");
    XLSX.writeFile(wb, `YOHOME_Members_${todayDate()}.xlsx`);
  }

  function downloadMembersPDF() {
    const doc = new jsPDF();

    doc.text("YOHOME Membership List", 14, 15);

    autoTable(doc, {
      startY: 22,
      head: [["Card ID", "Name", "Phone", "Email", "Join", "Expiry", "Status"]],
      body: members.map((m) => [
        m.card_id || "",
        m.full_name || "",
        m.phone || "",
        m.email || "",
        m.join_date || "",
        m.expiry_date || "",
        m.status || "",
      ]),
    });

    doc.save(`YOHOME_Members_${todayDate()}.pdf`);
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
      head: [["Date", "Customer", "Service", "Income", "Staff", "Profit", "Payment"]],
      body: checkouts.map((r) => [
        r.created_at ? new Date(r.created_at).toLocaleString() : "",
        r.customer_name || "",
        r.service_name || "",
        `$${money(r.final_price)}`,
        `$${money(r.staff_pay)}`,
        `$${money(r.shop_profit)}`,
        r.payment_method || "",
      ]),
    });

    doc.save(`YOHOME_Income_Report_${todayDate()}.pdf`);
  }
    return (
    <div className="app">
      <aside className="sidebar">
        <h1>YOHOME</h1>
        <p>Membership System</p>

        <div className="modeBox">
          <span>Current View</span>
          <select value={viewMode} onChange={(e) => handleViewModeChange(e.target.value)}>
            <option value="staff">Staff View</option>
            <option value="owner">Owner View</option>
          </select>
        </div>

        <button onClick={() => setTab("dashboard")} className={tab === "dashboard" ? "active" : ""}>
          Dashboard
        </button>
        <button onClick={() => setTab("members")} className={tab === "members" ? "active" : ""}>
          Members
        </button>
        <button onClick={() => setTab("checkout")} className={tab === "checkout" ? "active" : ""}>
          Checkout
        </button>
        <button onClick={() => setTab("reports")} className={tab === "reports" ? "active" : ""}>
          Reports
        </button>

        <div className="side-note">
          {supabase ? "Cloud database connected" : "Supabase not connected yet"}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h2>{tab.toUpperCase()}</h2>
            <span>
              {isOwner
                ? "Owner view: full finance, export and manual price control"
                : "Staff view: finance profit hidden"}
            </span>
          </div>
          <button onClick={loadData}>Refresh</button>
        </div>

        {loading && <div className="notice">Loading...</div>}

        {tab === "dashboard" && (
          <>
            <div className="cards">
              <div className="card">
                <span>Today Income</span>
                <strong>${money(todayStats.income)}</strong>
              </div>

              {isOwner && (
                <>
                  <div className="card">
                    <span>Staff Pay</span>
                    <strong>${money(todayStats.staff)}</strong>
                  </div>
                  <div className="card">
                    <span>Shop Profit</span>
                    <strong>${money(todayStats.profit)}</strong>
                  </div>
                </>
              )}

              <div className="card">
                <span>Today Checkouts</span>
                <strong>{todayStats.count}</strong>
              </div>
            </div>

            <section className="panel">
              <h3>Recent Checkouts</h3>
              <TableCheckouts rows={checkouts.slice(0, 8)} isOwner={isOwner} />
            </section>
          </>
        )}

        {tab === "members" && (
          <div className="grid-two">
            <section className="panel">
              <h3>Register New Member</h3>

              <form onSubmit={addMember} className="form">
                <label>Card ID</label>
                <input
                  placeholder="Leave blank for auto ID"
                  value={memberForm.card_id}
                  onChange={(e) => setMemberForm({ ...memberForm, card_id: e.target.value })}
                />

                <label>Full Name</label>
                <input
                  value={memberForm.full_name}
                  onChange={(e) => setMemberForm({ ...memberForm, full_name: e.target.value })}
                />

                <label>Phone</label>
                <input
                  value={memberForm.phone}
                  onChange={(e) => setMemberForm({ ...memberForm, phone: e.target.value })}
                />

                <label>Email</label>
                <input
                  value={memberForm.email}
                  onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })}
                />

                {existingMemberWarning && (
                  <div className="warningBox">
                    Possible existing member: {existingMemberWarning.full_name} ·{" "}
                    {existingMemberWarning.phone} · {existingMemberWarning.email || "No email"} ·{" "}
                    {existingMemberWarning.card_id}
                  </div>
                )}

                <label>Expiry Date</label>
                <input
                  type="date"
                  value={memberForm.expiry_date}
                  onChange={(e) => setMemberForm({ ...memberForm, expiry_date: e.target.value })}
                />

                <label>Payment Method</label>
                <select
                  value={memberForm.payment_method}
                  onChange={(e) => setMemberForm({ ...memberForm, payment_method: e.target.value })}
                >
                  <option>Cash</option>
                  <option>Card</option>
                  <option>Bank Transfer</option>
                </select>

                <label>Notes</label>
                <textarea
                  value={memberForm.notes}
                  onChange={(e) => setMemberForm({ ...memberForm, notes: e.target.value })}
                />

                <button className="primary">Save Member - ${YEAR_FEE}</button>
              </form>

              {memberForm.card_id && (
                <div className="barcodeBox">
                  <svg ref={barcodeRef}></svg>
                </div>
              )}
            </section>

            <section className="panel">
              <h3>Member Search</h3>
              <input
                className="search"
                placeholder="Search by name / phone / email / card ID"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
              />

              <div className="memberList">
                {filteredMembers.map((m) => {
                  const expired = new Date(m.expiry_date) < new Date(todayDate());

                  return (
                    <div className="memberItem" key={m.id}>
                      <div>
                        <strong>{m.full_name}</strong>
                        <p>{m.phone || "No phone"} · {m.email || "No email"} · {m.card_id}</p>
                        <p>
                          Join: {m.join_date || "-"} · Expiry: {m.expiry_date}{" "}
                          <span className={expired ? "badge bad" : "badge good"}>
                            {expired ? "Expired" : "Active"}
                          </span>
                        </p>
                      </div>

                      <div className="rowBtns">
                        <button onClick={() => renewMember(m)}>Renew</button>
                        {isOwner && (
                          <button className="danger" onClick={() => deleteMember(m)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "checkout" && (
          <div className="grid-two">
            <section className="panel">
              <h3>Service Checkout</h3>

              <label>Search Member</label>
              <input
                className="search"
                placeholder="Phone / Card ID / Name / Email"
                value={checkoutSearch}
                onChange={(e) => setCheckoutSearch(e.target.value)}
              />

              {checkoutSearchResults.length > 0 && (
                <div className="searchDropdown">
                  {checkoutSearchResults.map((m) => (
                    <div key={m.id} onClick={() => selectCheckoutMember(m)}>
                      {m.full_name} · {m.phone || "No phone"} · {m.email || "No email"} · {m.card_id}
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={saveCheckout} className="form">
                <label>Customer</label>
                <select
                  value={checkoutForm.member_id}
                  onChange={(e) =>
                    setCheckoutForm({ ...checkoutForm, member_id: e.target.value })
                  }
                >
                  <option value="guest">Guest</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name} · {m.phone || ""} · {m.card_id}
                    </option>
                  ))}
                </select>

                <label>Service</label>
                <select
                  value={checkoutForm.service_id}
                  onChange={(e) =>
                    setCheckoutForm({ ...checkoutForm, service_id: e.target.value })
                  }
                >
                  <option value="">Select service</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <label>Payment</label>
                <select
                  value={checkoutForm.payment_method}
                  onChange={(e) =>
                    setCheckoutForm({ ...checkoutForm, payment_method: e.target.value })
                  }
                >
                  <option>Cash</option>
                  <option>Card</option>
                  <option>Bank Transfer</option>
                </select>

                {isOwner && (
                  <>
                    <label>Manual Price</label>
                    <input
                      type="number"
                      placeholder="Optional owner price"
                      value={checkoutForm.manual_price}
                      onChange={(e) =>
                        setCheckoutForm({ ...checkoutForm, manual_price: e.target.value })
                      }
                    />

                    <label>Discount</label>
                    <input
                      type="number"
                      placeholder="Optional discount"
                      value={checkoutForm.discount_amount}
                      onChange={(e) =>
                        setCheckoutForm({ ...checkoutForm, discount_amount: e.target.value })
                      }
                    />

                    <label>Price Note</label>
                    <input
                      placeholder="Reason for discount or price change"
                      value={checkoutForm.price_note}
                      onChange={(e) =>
                        setCheckoutForm({ ...checkoutForm, price_note: e.target.value })
                      }
                    />
                  </>
                )}

                {pricePreview && (
                  <div className="priceBox">
                    <p>Base Price: ${money(pricePreview.basePrice)}</p>
                    <p>Final Price: ${money(pricePreview.finalPrice)}</p>

                    {isOwner && (
                      <>
                        <p>Staff Pay: ${money(pricePreview.staffPay)}</p>
                        <p>Profit: ${money(pricePreview.shopProfit)}</p>
                        <p>Discount: ${money(pricePreview.discount)}</p>
                      </>
                    )}

                    <strong>{pricePreview.note}</strong>
                  </div>
                )}

                <button className="primary">Confirm Checkout</button>
              </form>
            </section>

            <section className="panel">
              <h3>Latest Records</h3>
              <TableCheckouts rows={checkouts.slice(0, 20)} isOwner={isOwner} />
            </section>
          </div>
        )}

        {tab === "reports" && (
          <section className="panel">
            <h3>Reports & Backup</h3>

            {isOwner && (
              <div className="exportBtns">
                <button onClick={downloadMembersExcel}>Download Members Excel</button>
                <button onClick={downloadMembersPDF}>Download Members PDF</button>
                <button onClick={downloadIncomePDF}>Download Income Report PDF</button>
              </div>
            )}

            {!isOwner && (
              <div className="notice">
                Staff view: export and profit report are hidden. Please switch to Owner View.
              </div>
            )}

            <TableCheckouts rows={checkouts} isOwner={isOwner} />
          </section>
        )}
      </main>
    </div>
  );
}

function TableCheckouts({ rows, isOwner }) {
  if (!rows?.length) return <p className="empty">No records yet.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Service</th>
            <th>Price</th>
            {isOwner && (
              <>
                <th>Staff</th>
                <th>Profit</th>
                <th>Payment</th>
                <th>Note</th>
              </>
            )}
          </tr>
        </thead>

        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
              <td>{r.customer_name}</td>
              <td>{r.service_name}</td>
              <td>${money(r.final_price)}</td>

              {isOwner && (
                <>
                  <td>${money(r.staff_pay)}</td>
                  <td>${money(r.shop_profit)}</td>
                  <td>{r.payment_method || ""}</td>
                  <td>{r.price_note || ""}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}