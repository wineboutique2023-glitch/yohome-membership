import { useEffect, useRef, useState } from "react";
import "./GiftCards.css";

const payments = ["Cash", "Tyro", "Stripe", "Bank Transfer", "Other"];
const aud = (cents) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(cents ?? 0) / 100);
const labels = {
  sold: "Gift card sale receipts", redeemed: "Gift card value redeemed",
  topup: "Checkout top-ups received", transferred: "Balance transferred",
  outstanding: "Unredeemed active balance", expired_balance: "Expired balance",
};

function cents(value) {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) throw new Error("Enter an amount with up to two decimal places.");
  const [dollars, fraction = ""] = value.split(".");
  return Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
}

function Fields({ barcode = false, amount = false, expiry = false, reason = false, payment = false }) {
  return <>
    {barcode && <label>Barcode<input name="barcode" autoComplete="off" required /></label>}
    {amount && <label>{typeof amount === "string" ? amount : "Amount (AUD)"}<input name="amount" inputMode="decimal" required /></label>}
    {expiry && <label>Expiry date<input name="expires_on" type="date" required /></label>}
    {payment && <label>Payment Method<select name="payment" required><option value="">Select</option>{payments.map((p) => <option key={p}>{p}</option>)}</select></label>}
    {reason && <label>{typeof reason === "string" ? reason : "Reason"}<textarea name="reason" maxLength={1000} required /></label>}
  </>;
}

function serviceFamily(name) {
  if (/deep tissue/i.test(name)) return "Deep Tissue";
  if (/remedial|injury recovery/i.test(name)) return "Remedial";
  if (/myotherapy/i.test(name)) return "Myotherapy";
  return name;
}

function serviceLabel(service) {
  const minutes = Math.round(Number(service.duration) * 60);
  const duration = minutes && !/\d+\s*min\b/i.test(service.name) ? ` · ${minutes} min` : "";
  return `${service.name}${duration} · ${aud(service.price)}`;
}

function ServiceSelect({ services, value, onChange }) {
  return <label>Service<select name="service_code" value={value} required onChange={onChange}>
    <option value="">Select service</option>
    {services.filter((s) => s.active).map((s) => <option key={s.code} value={s.code}>{serviceLabel(s)}</option>)}
  </select></label>;
}

const pageLabels = {
  Checkout: "Use Card",
  Sales: "Sell Card",
  "Manage Gift Cards": "Manage Cards",
  "Legacy Claim": "Old Gift Card",
  Approvals: "Approve Old Cards",
  "Gift Services": "Gift Card Services",
};

const recordStatus = {
  stock: "Unsold", pending: "Pending Approval", active: "Active", rejected: "Declined",
  spent: "Fully Redeemed", exchanged: "Replaced", cancelled: "Cancelled",
};
const displayRecordStatus = (card) => card.status === "active" && card.is_expired ? "Expired" : recordStatus[card.status];

const historyLabels = {
  stock: "Registered", stock_batch: "Stock registered", sale: "Sold", redeem: "Used", exchange: "Replaced",
  transfer: "Balance transferred", claim: "Old card submitted",
  approve: "Approved", reject: "Declined", adjust: "Balance adjusted",
  correct_card: "Registration corrected", cancel_card: "Cancelled",
};

function History({ entries }) {
  return <div className="gift-history"><table><thead><tr>
    <th>Date</th><th>Action</th><th>Barcode</th><th>Service / payment</th><th>Balance</th><th>Applied / paid</th><th>Details</th>
  </tr></thead><tbody>{entries.map((entry, index) => {
    const { result: data } = entry;
    return <tr key={entry.request_id ?? index}>
      <td>{new Date(entry.created_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })}</td>
      <td>{historyLabels[entry.action] ?? entry.action}</td><td>{data.barcode}{data.replacement && ` → ${data.replacement}`}</td>
      <td>{[data.service_name, data.payment].filter(Boolean).join(" · ")}</td>
      <td>{data.before !== undefined && `${aud(data.before)} → ${aud(data.after)}`}</td>
      <td>{data.redeemed !== undefined && `Applied ${aud(data.redeemed)} · Top-up ${aud(data.topup)}`}{data.cash_sale !== undefined && aud(data.cash_sale)}</td>
      <td>{[data.actor_name, data.reason, data.review_notes,
        Object.hasOwn(data, "registration_note") && `Note: ${data.previous_note ?? "—"} → ${data.registration_note ?? "—"}`,
        data.transferred > 0 && `Transferred ${aud(data.transferred)}`].filter(Boolean).join(" · ")}</td>
    </tr>;
  })}</tbody></table></div>;
}

const historyPageSize = 5;

const historyAmounts = new Set([
  "before", "after", "claimed", "cash_sale", "redeemed", "topup", "transferred",
  "service_price", "service_value", "service_value_released", "price", "balance",
]);

function historyDetailValue(key, value) {
  if (value == null || value === "") return "—";
  if (historyAmounts.has(key)) return aud(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function CardHistory({ barcode, entries }) {
  const [selectedPage, setSelectedPage] = useState(1);
  const ordered = [...entries].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const pageCount = Math.max(1, Math.ceil(ordered.length / historyPageSize));
  const page = Math.min(selectedPage, pageCount);
  const offset = (page - 1) * historyPageSize;

  return <section className="gift-card-history" aria-label={`Card History for ${barcode}`}>
    <h4>Card History <span>· {barcode}</span></h4>
    {ordered.length === 0 ? <p>No activity yet.</p> : <div className="gift-history"><table>
      <thead><tr><th scope="col">Date</th><th scope="col">Action</th><th scope="col">Service / payment</th>
        <th scope="col">Balance</th><th scope="col">Applied / paid</th><th scope="col">Details</th></tr></thead>
      <tbody>{ordered.slice(offset, offset + historyPageSize).map((entry, index) => {
        const data = entry.result;
        const related = [data.barcode, data.replacement].filter((code) => code && code !== barcode);
        return <tr key={entry.request_id ?? offset + index}>
          <td>{new Date(entry.created_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })}</td>
          <td>{historyLabels[entry.action] ?? entry.action}
            {related.length > 0 && <small>Related: {related.join(" → ")}</small>}</td>
          <td>{[data.service_name, data.payment].filter(Boolean).join(" · ") || "—"}</td>
          <td>{data.before !== undefined ? `${aud(data.before)} → ${aud(data.after)}` : "—"}</td>
          <td>{data.redeemed !== undefined && `Applied ${aud(data.redeemed)} · Top-up ${aud(data.topup)}`}{data.cash_sale !== undefined && aud(data.cash_sale)}</td>
          <td><details><summary>View details</summary>
            <dl>{Object.entries(data).filter(([key, value]) =>
              !["barcode", "replacement"].includes(key) || value && value !== barcode
            ).map(([key, value]) => <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt><dd>{historyDetailValue(key, value)}</dd>
            </div>)}</dl>
          </details></td>
        </tr>;
      })}</tbody>
    </table></div>}
    <div className="gift-history-pages">
      <button type="button" disabled={page <= 1} onClick={() => setSelectedPage(page - 1)}>Previous</button>
      <span aria-live="polite">Page {page} of {pageCount} · {ordered.length} {ordered.length === 1 ? "record" : "records"}</span>
      <button type="button" disabled={page >= pageCount} onClick={() => setSelectedPage(page + 1)}>Next</button>
    </div>
  </section>;
}

export function SignIn({ client, title }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const fields = new FormData(event.currentTarget);
      const { error } = await client.auth.signInWithPassword({ email: fields.get("email").trim(), password: fields.get("password") });
      if (error) setMessage(error.message);
    } catch {
      setMessage("Could not sign in. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }
  return <section className="panel gift-panel"><h3>{title}</h3>
    <form className="form" onSubmit={signIn}>
      <label>Email<input type="email" name="email" autoComplete="username" required /></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {message && <p role="alert">{message}</p>}
  </section>;
}

export default function GiftCards({ ownerView, client, userId, serviceDate, sellers, onLedgerChange }) {
  const storageKey = `yohome-gift-pending:${userId}`;
  const [request, setRequest] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey)) ?? null;
    } catch {
      return null;
    }
  });
  const [overview, setOverview] = useState(null);
  const [page, setPage] = useState("Checkout");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [result, setResult] = useState(null);
  const [card, setCard] = useState(null);
  const [missingBarcode, setMissingBarcode] = useState("");
  const [claimOld, setClaimOld] = useState(false);
  const [salePayment, setSalePayment] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [checkoutService, setCheckoutService] = useState("");
  const [redeemInput, setRedeemInput] = useState("");
  const [saleType, setSaleType] = useState("dollar");
  const [saleFamily, setSaleFamily] = useState("");
  const [saleService, setSaleService] = useState("");
  const [saleValue, setSaleValue] = useState("");
  const [manageAction, setManageAction] = useState("");
  const [pending, setPending] = useState(null);
  const [reviewBarcode, setReviewBarcode] = useState("");
  const [report, setReport] = useState(null);
  const [manageView, setManageView] = useState("records");
  const [recordCursors, setRecordCursors] = useState([""]);
  const [records, setRecords] = useState(null);
  const [recordsError, setRecordsError] = useState("");
  const [recordsRevision, setRecordsRevision] = useState(0);
  const manageOwner = ownerView && overview?.role === "owner";
  const recordCursor = recordCursors.at(-1);

  useEffect(() => {
    if (!manageOwner || page !== "Manage Gift Cards" || manageView !== "records") return;
    let current = true;
    async function loadRecords() {
      try {
        const { data, error } = await client.rpc("membership_gift_card", {
          action_name: "manage_list", args: { after: recordCursor },
        });
        if (error) throw new Error(error.message);
        if (current) setRecords(data);
      } catch (error) {
        if (current) setRecordsError(error.message);
      }
    }
    void loadRecords();
    return () => { current = false; };
  }, [client, manageOwner, page, manageView, recordCursor, recordsRevision]);

  const running = useRef(false);

  useEffect(() => {
    let current = true;
    client.rpc("membership_gift_card", { action_name: "overview" }).then(({ data, error }) => {
      if (!current) return;
      if (error) {
        setIsError(true);
        setMessage(error.message);
      } else setOverview(data);
    }).catch(() => {
      if (current) {
        setIsError(true);
        setMessage("Could not load gift card access. Reopen Gift Cards to retry.");
      }
    });
    return () => { current = false; };
  }, [client]);

  const eligibleBarcode = page === "Checkout" && card?.status === "active" && !card.is_expired
    ? card.barcode : null;
  const editableAmount = card?.kind === "dollar";
  useEffect(() => {
    if (!eligibleBarcode || !checkoutService) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const args = { barcode: eligibleBarcode, service_code: checkoutService };
        if (editableAmount && redeemInput) args.redeem_amount = cents(redeemInput);
        const { data, error } = await client.rpc("membership_gift_card", { action_name: "quote", args });
        if (error) throw new Error(error.message);
        if (current) {
          setQuote(data);
          setQuoteError("");
        }
      } catch (error) {
        if (current) setQuoteError(error.message);
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [client, eligibleBarcode, checkoutService, editableAmount, redeemInput]);

  function saveRequest(value) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setRequest(value);
  }

  async function run(action, args, onResult, write = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const signature = JSON.stringify([action, args]);
      if (write && request && request.signature !== signature) {
        throw new Error("Retry the previous submission with its original details before starting another transaction.");
      }
      const operation = write ? request ?? { action, args, signature, id: crypto.randomUUID() } : null;
      if (write && !request) saveRequest(operation);
      const { data, error, status } = await client.rpc("membership_gift_card", {
        action_name: action, args, operation_id: operation?.id ?? null,
      });
      if (error) {
        if (action === "lookup" && page === "Checkout" && error.message === "Card not found") {
          setMissingBarcode(args.barcode);
        }
        if (write && [400, 409].includes(status) && /^(22|23|P0001)/.test(error.code ?? "")) saveRequest(null);
        throw new Error(error.message);
      }
      if (write) {
        saveRequest(null);
        setResult(data);
        setMessage("Saved.");
        if (["stock", "stock_batch", "correct_card", "cancel_card"].includes(action)) {
          setRecords(null);
          setRecordsError("");
          setRecordsRevision((value) => value + 1);
        }
        if (["sale", "redeem", "exchange"].includes(action)) void onLedgerChange();
      }
      onResult?.(data);
    } catch (error) {
      setIsError(true);
      setMessage(error.message);
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  function submit(event, action, onResult, extras = {}) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const args = Object.fromEntries([...fields].filter(([, value]) => value !== ""));
    if (args.unused_value_confirmed === "true") args.unused_value_confirmed = true;
    try {
      if (args.redeem_amount !== undefined) args.redeem_amount = cents(args.redeem_amount);
      if (args.amount !== undefined) args.amount = cents(args.amount);
    } catch (error) {
      setMessage(error.message);
      setIsError(true);
      return;
    }
    void run(action, { ...args, ...extras }, onResult, !["lookup", "manage_lookup", "quote"].includes(action));
  }

  function transferBalance(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run("transfer", {
      barcode: card.barcode,
      replacement: fields.get("replacement"),
      old_card_collected: fields.get("old_card_collected"),
      amount: card.balance,
    }, () => { setCard(null); setQuote(null); }, true);
  }

  function findCheckoutCard() {
    const barcode = barcodeInput.trim();
    if (!barcode || barcode === card?.barcode || barcode === missingBarcode) return;
    setResult(null);
    void run("lookup", { barcode }, setCard);
  }

  function selectPage(next, barcode = "") {
    if (request) {
      setMessage("Retry the previous submission before leaving this page.");
      setIsError(true);
      return;
    }
    setPage(next);
    if (next === "Manage Gift Cards") {
      setManageView("records");
      setRecordCursors([""]);
      setRecords(null);
      setRecordsError("");
      setRecordsRevision((value) => value + 1);
    }
    setBarcodeInput("");
    setCheckoutService("");
    setRedeemInput("");
    setQuoteError("");
    setCard(null);
    setQuote(null);
    setResult(null);
    setSaleType("dollar");
    setSaleFamily("");
    setSaleService("");
    setSaleValue("");
    setManageAction("");
    setSalePayment("");
    setMissingBarcode("");
    setClaimOld(false);
    setMessage("");
    if (next === "Approvals") {
      setPending(null);
      setReviewBarcode(barcode);
      void run("pending", barcode ? { barcode } : {}, setPending);
    }
    if (next === "Reports") void run("report", {}, setReport);
  }

  const owner = manageOwner;
  const services = overview?.services ?? [];
  const saleFamilies = [...new Set(services.map((service) => serviceFamily(service.name)))];
  const saleOptions = services.filter((service) => serviceFamily(service.name) === saleFamily)
    .sort((a, b) => Number(a.duration) - Number(b.duration));
  const cardServices = card?.kind === "service"
    ? [{
      code: card.service_code, name: card.service_name, price: card.service_value,
      duration: card.service_duration, active: true,
    }, ...services.filter((s) => s.code !== card.service_code)]
    : services;
  const primaryPages = owner ? ["Sales", "Checkout", "Manage Gift Cards"] : ["Sales", "Checkout"];
  const tools = owner ? ["Legacy Claim", "Approvals", "Unsold Card Stock", "Balance Adjustment", "Gift Services", "Reports"] : ["Legacy Claim"];
  const selectedSaleService = saleOptions.find((service) => service.code === saleService);
  const dollarSummary = /^\d{1,7}(\.\d{1,2})?$/.test(saleValue) ? aud(cents(saleValue)) : "—";

  return <section className="panel gift-panel gift-workspace">
    <h3>Gift Cards</h3>
    {request && <div className="gift-actions">
      <p>A saved {request.action} submission is awaiting a result.</p>
      <button type="button" disabled={busy} onClick={() => void run(request.action, request.args, () => {
        setCard(null);
        setQuote(null);
        if (request.action === "approve" || request.action === "reject") {
          setPending((current) => current?.filter((item) => item.barcode !== request.args.barcode));
        }
      }, true)}>Recover transaction result</button>
    </div>}
    {overview && <>
      <nav className="gift-primary" aria-label="Gift card functions">{primaryPages.map((name) =>
        <button type="button" key={name} disabled={busy} aria-pressed={page === name} onClick={() => selectPage(name)}>{pageLabels[name]}</button>
      )}</nav>
      <details className="gift-tools">
        <summary>{owner ? "Owner Tools" : "More"}</summary>
        <div className="gift-actions">{tools.map((name) =>
          <button type="button" key={name} disabled={busy} aria-pressed={page === name}
            onClick={() => selectPage(name)}>{pageLabels[name] ?? name}</button>
        )}</div>
      </details>
      <fieldset key={page} disabled={busy} className="gift-fields">
        {page !== "Checkout" && <h4>{pageLabels[page] ?? page}</h4>}
        {page === "Checkout" && <div className="gift-checkout">
          <h4>Use Gift Card</h4>
          <label>Scan Gift Card Barcode<input value={barcodeInput} placeholder="Scan or enter barcode"
            autoComplete="off" onBlur={findCheckoutCard}
            onChange={(e) => {
              setBarcodeInput(e.target.value);
              setCard(null);
              setQuote(null);
              setQuoteError("");
              setMissingBarcode("");
              setClaimOld(false);
              setMessage("");
              setResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); findCheckoutCard(); }
            }} /></label>
          <div className="gift-scan-status" aria-live="polite">{card ?
            `${card.barcode} · ${card.is_expired ? "Expired" : card.status === "spent" ? "Fully Redeemed" : card.status}${card.expires_on ? ` · Expires ${card.expires_on}` : ""}`
            : "Scan a card or press Enter to check its balance."}</div>
          <form className="form" onSubmit={(e) => {
            e.preventDefault();
            if (!eligibleBarcode || !quote || request) return;
            const exchange = Boolean(new FormData(e.currentTarget).get("replacement"));
            submit(e, exchange ? "exchange" : "redeem", () => {
              setCard(null);
              setQuote(null);
              setBarcodeInput("");
              setRedeemInput("");
            }, { barcode: eligibleBarcode, service_code: quote.service_code, quote,
              ...(editableAmount && { redeem_amount: quote.redeemed }) });
          }}>
            <ServiceSelect services={cardServices} value={checkoutService} onChange={(e) => {
              setCheckoutService(e.target.value); setQuote(null); setQuoteError("");
            }} />
            <div className="gift-checkout-pair">
              <label>Therapist<select name="therapist" required>
                <option value="">Select therapist</option>
                {sellers.map((name) => <option key={name}>{name}</option>)}
              </select></label>
              <label>Service Date<input name="checkout_date" type="date" defaultValue={serviceDate} required /></label>
            </div>
            <label>Redeem Amount ($)<input name={editableAmount ? "redeem_amount" : undefined}
              inputMode="decimal" value={eligibleBarcode && !editableAmount ? (quote ? (quote.redeemed / 100).toFixed(2) : "") : redeemInput}
              readOnly={Boolean(eligibleBarcode && !editableAmount)}
              onChange={(e) => { setRedeemInput(e.target.value); setQuote(null); setQuoteError(""); }} /></label>
            <label>Extra Payment Method<select name="payment" required={quote?.topup > 0}>
              <option value="">Select payment method</option>
              {payments.map((payment) => <option key={payment}>{payment}</option>)}
            </select></label>
            {quoteError && <p role="alert">{quoteError}</p>}
            {quote?.service_value_released > 0 && <label>
              <input name="unused_value_confirmed" type="checkbox" value="true" required />
              Customer accepts the unused value of {aud(quote.service_value_released)} being forfeited.
            </label>}
            {quote?.topup > 0 && <label><input name="payment_confirmed" type="checkbox" value="true" required /> Balance payment received</label>}
            {card?.kind === "legacy" && quote?.after > 0 && <>
              <label>Replacement barcode (optional)<input name="replacement" autoComplete="off"
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
              <label><input name="old_card_collected" type="checkbox" value="true" /> Old physical card collected for exchange</label>
            </>}
            <dl className="gift-checkout-totals">
              <div><dt>Service Price</dt><dd>{quote ? aud(quote.service_price) : "—"}</dd></div>
              <div><dt>Gift Card Balance</dt><dd>{card ? aud(card.balance) : "—"}</dd></div>
              <div><dt>Redeem Now</dt><dd>{quote ? aud(quote.redeemed) : "—"}</dd></div>
              <div><dt>Remaining Balance</dt><dd>{quote ? aud(quote.after) : "—"}</dd></div>
              <div className="gift-checkout-pay"><dt>Customer Pays</dt><dd>{quote ? aud(quote.topup) : "—"}</dd></div>
            </dl>
            <button className="primary" disabled={!eligibleBarcode || !quote || Boolean(request)}>Confirm Checkout</button>
          </form>
          <div className="gift-checkout-old">
            <label><input type="checkbox" disabled={!missingBarcode} checked={claimOld}
              onChange={(e) => setClaimOld(e.target.checked)} /> Existing Previous Old Card</label>
            {missingBarcode && claimOld && <form className="form" onSubmit={(e) => submit(e, "claim",
              () => { setMissingBarcode(""); setClaimOld(false); setBarcodeInput(""); }, { barcode: missingBarcode })}>
              <p>Old card: {missingBarcode}</p>
              <Fields amount="Claimed old card value (AUD)" />
              <label>Old Card Expiry Date<input name="old_expires_on" type="date" required /></label>
              <button>Submit for owner approval</button>
            </form>}
          </div>
          {card && <CardHistory key={card.barcode} barcode={card.barcode} entries={card.history} />}
        </div>}
        {owner && page === "Manage Gift Cards" && <>
          <div className="gift-actions" aria-label="Manage card options">
            <button type="button" aria-pressed={manageView === "records"} onClick={() => setManageView("records")}>Card Records</button>
            <button type="button" aria-pressed={manageView === "add"} onClick={() => { setManageView("add"); setCard(null); }}>Add Card</button>
          </div>
          {manageView === "add" ? <form className="form" onSubmit={(e) => {
            const form = e.currentTarget;
            submit(e, "stock", () => form.reset());
          }}>
            <label>Barcode<input name="barcode" autoComplete="off" placeholder="Scan or enter barcode" required
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.form.elements.reason.focus(); } }} /></label>
            <Fields reason="Reason for registration" />
            <button className="primary">Register Unsold Card</button>
          </form> : <>
            <form className="form" onSubmit={(e) => {
              setCard(null);
              setManageAction("");
              submit(e, "manage_lookup", setCard);
            }}>
              <label>Search Barcode<input name="barcode" type="search" autoComplete="off" required /></label>
              <button>Find Card</button>
            </form>
            {recordsError && <p role="alert">{recordsError}</p>}
            {!recordsError && !records && <p role="status">Loading card records…</p>}
            {records?.length === 0 && <p>No card records on this page.</p>}
            {records?.length > 0 && <div className="gift-history gift-records">
              <table><thead><tr><th>Barcode</th><th>Status</th><th>Original Value</th><th>Remaining Balance</th><th>Expiry Date</th></tr></thead>
                <tbody>{records.slice(0, 50).map((record) => <tr key={record.barcode}>
                  <td><button type="button" onClick={() => {
                    setCard(null);
                    setManageAction("");
                    void run("manage_lookup", { barcode: record.barcode }, setCard);
                  }}>{record.barcode}</button></td>
                  <td>{displayRecordStatus(record)}</td>
                  <td>{record.original_value == null ? "—" : aud(record.original_value)}</td>
                  <td>{aud(record.balance)}</td>
                  <td>{record.expires_on ?? "—"}</td>
                </tr>)}</tbody>
              </table>
            </div>}
            {(recordCursors.length > 1 || records?.length > 50) && <div className="gift-actions">
              <button type="button" disabled={recordCursors.length === 1 || !records} onClick={() => {
                setRecords(null); setRecordsError(""); setRecordCursors((values) => values.slice(0, -1));
              }}>Previous</button>
              <button type="button" disabled={!(records?.length > 50)} onClick={() => {
                setRecordCursors((values) => [...values, records[49].barcode]); setRecords(null); setRecordsError("");
              }}>Next</button>
            </div>}
          </>}
          {card && <div className="gift-card-detail" key={card.barcode}>
            <h4>{card.barcode}</h4>
            <p>{card.kind} · {displayRecordStatus(card)} · {aud(card.balance)}
              {card.expires_on && ` · Expires ${card.expires_on}`}</p>
            {card.service_name && <p>{serviceLabel({
              name: card.service_name, duration: card.service_duration, price: card.service_value,
            })}</p>}
            {owner && card.status === "pending" && <button type="button" onClick={() => selectPage("Approvals", card.barcode)}>Review Old Card</button>}
            {owner && card.status !== "pending" && <div className="gift-actions">
              <button type="button" aria-expanded={manageAction === "edit"}
                onClick={() => setManageAction(manageAction === "edit" ? "" : "edit")}>Edit</button>
              {card.can_cancel && <button type="button" className="danger" aria-expanded={manageAction === "cancel"}
                onClick={() => setManageAction(manageAction === "cancel" ? "" : "cancel")}>Cancel</button>}
            </div>}
            {owner && manageAction === "edit" && <form className="form" onSubmit={(e) => {
              const note = new FormData(e.currentTarget).get("registration_note");
              submit(e, "correct_card", () => setCard(null),
                { barcode: card.barcode, registration_note: note });
            }}>
              <label>Registration Note<textarea name="registration_note" defaultValue={card.registration_note ?? ""} maxLength={1000} /></label>
              <Fields reason="Reason for correction" />
              <button>Save Correction</button>
            </form>}
            {owner && card.can_cancel && manageAction === "cancel" && <form className="form" onSubmit={(e) =>
              submit(e, "cancel_card", () => setCard(null), { barcode: card.barcode })}>
              <p>Cancelling retires this barcode. The card record and its history are retained.</p>
              <Fields reason="Reason for cancellation" />
              <label><input type="checkbox" required /> Confirm this card should be cancelled</label>
              <button className="danger">Cancel Card</button>
            </form>}
            <CardHistory key={card.barcode} barcode={card.barcode} entries={card.history} />
          </div>}
        </>}
        {page === "Sales" && (salePayment === "transfer" ? <>
          <label>Payment Method<select value={salePayment} onChange={(e) => { setSalePayment(e.target.value); setCard(null); }}>
            <option value="">Back to card sale</option>
            <option value="transfer">Existing Old Card / Balance Transfer</option>
          </select></label>
          <form className="form" onSubmit={(e) => { setCard(null); submit(e, "lookup", setCard); }}>
            <label>Scan Old Card Barcode<input name="barcode" autoComplete="off" required /></label>
            <button>Find Old Card</button>
          </form>
          {card && (card.kind === "legacy" && card.status === "active" && !card.is_expired ?
            <form className="form" onSubmit={transferBalance}>
              <p>{card.barcode} · {aud(card.balance)} · Expires {card.expires_on}</p>
              <label>Scan New Card Barcode<input name="replacement" autoComplete="off" required
                onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
              <label><input name="old_card_collected" type="checkbox" value="true" required /> Old physical card collected</label>
              <button className="primary">Transfer Balance</button>
            </form> : <p>Scan an approved, active old card to transfer its balance.</p>)}
        </> : <form className="form" onSubmit={(e) => submit(e, "sale")}>
          <Fields barcode />
          <label>Gift Card Type<select value={saleType} onChange={(e) => {
            setSaleType(e.target.value);
            setSaleFamily("");
            setSaleService("");
            setSaleValue("");
          }}>
            <option value="dollar">Dollar Value</option>
            <option value="service">Service Gift</option>
          </select></label>
          {saleType === "service" ? <>
            <label>Service Category<select value={saleFamily} required onChange={(e) => {
              setSaleFamily(e.target.value);
              setSaleService("");
            }}>
              <option value="">Select category</option>
              {saleFamilies.map((family) => <option key={family}>{family}</option>)}
            </select></label>
            <label>Duration<select name="service_code" value={saleService} required disabled={!saleFamily}
              onChange={(e) => setSaleService(e.target.value)}>
              <option value="">Select duration</option>
              {saleOptions.map((service) => <option key={service.code} value={service.code}>{serviceLabel(service)}</option>)}
            </select></label>
          </> : <label>Dollar Value (AUD)<input name="amount" inputMode="decimal" required
            value={saleValue} onChange={(e) => setSaleValue(e.target.value)} /></label>}
          <label>Sold By<input value={overview.name} readOnly /></label>
          <label>Payment Method<select name="payment" required value={salePayment} onChange={(e) => setSalePayment(e.target.value)}>
            <option value="">Select</option>
            {payments.map((payment) => <option key={payment}>{payment}</option>)}
            <option value="transfer">Existing Old Card / Balance Transfer</option>
          </select></label>
          <Fields expiry />
          <div className="priceBox gift-summary">
            <strong>Summary</strong>
            <span>{saleType === "service" ? selectedSaleService ? serviceLabel(selectedSaleService) : "Select a service" : dollarSummary}</span>
          </div>
          <button className="primary">Confirm Sale</button>
        </form>)}
        {page === "Legacy Claim" && <form className="form" onSubmit={(e) => submit(e, "claim")}>
          <Fields barcode amount="Claimed old card value (AUD)" />
          <label>Old Card Expiry Date<input name="old_expires_on" type="date" required /></label>
          <button>Submit for owner approval</button>
        </form>}
        {owner && page === "Approvals" && <>
          {reviewBarcode && <button type="button" onClick={() => selectPage("Approvals")}>All Pending Claims</button>}
          <button type="button" onClick={() => void run("pending", reviewBarcode ? { barcode: reviewBarcode } : {}, setPending)}>Refresh claims</button>
          {pending?.length === 0 && <p>No pending claims.</p>}
          {pending?.map((item) => <form className="form gift-review" key={item.barcode} onSubmit={(e) => {
            const action = e.nativeEvent.submitter?.value;
            if (!["approve", "reject"].includes(action)) { e.preventDefault(); return; }
            if (action === "reject") {
              e.preventDefault();
              const fields = new FormData(e.currentTarget);
              const reason = String(fields.get("reason") ?? "").trim();
              if (!reason) { setIsError(true); setMessage("Enter a review reason."); return; }
              void run("reject", { barcode: item.barcode, reason, review_notes: fields.get("review_notes") },
                () => setPending((current) => current.filter((c) => c.barcode !== item.barcode)), true);
              return;
            }
            submit(e, action, () => setPending((current) => current.filter((c) => c.barcode !== item.barcode)), { barcode: item.barcode });
          }}>
            <p><strong>Barcode:</strong> {item.barcode}</p>
            <p><strong>Claimed Value:</strong> {aud(item.claim.claimed)}</p>
            <p><strong>Old Card Expiry Date:</strong> {item.claim.old_expires_on ?? "Not recorded"}</p>
            <p><strong>Submitted by:</strong> {item.claim.actor_name} · {new Date(item.submitted_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })}</p>
            {item.claim.reason && <p><strong>Previous notes:</strong> {item.claim.reason}</p>}
            <Fields amount="Approved balance (AUD)" reason="Review reason" />
            <label>Approved Expiry Date<input name="expires_on" type="date" defaultValue={item.claim.old_expires_on ?? ""} required /></label>
            <label>Review Notes (optional)<textarea name="review_notes" maxLength={1000} /></label>
            <label><input name="physical_card_verified" type="checkbox" value="true" required /> Physical old card verified</label>
            <div className="gift-actions"><button value="approve">Approve</button><button value="reject" formNoValidate>Reject</button></div>
          </form>)}
        </>}
        {page === "Unsold Card Stock" && <form className="form" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const barcodes = new FormData(form).get("barcodes").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
          void run("stock_batch", { barcodes }, () => form.reset(), true);
        }}>
          <label>Barcodes (one per line)<textarea name="barcodes" required /></label>
          <button>Register Unsold Cards</button>
        </form>}
        {page === "Balance Adjustment" && <form className="form" onSubmit={(e) => submit(e, "adjust")}>
          <p>For unused service gifts, enter zero to void the gift. Its original service value is fixed.</p>
          <Fields barcode amount="New balance (AUD)" reason /><button>Save audited adjustment</button>
        </form>}
        {page === "Gift Services" && <>
          <p>Manage service names, durations and standard prices in CRM Services.</p>
          {services.length > 0 && <ul>{services.map((service) =>
            <li key={service.code}>{serviceLabel(service)}</li>)}</ul>}
        </>}
        {page === "Reports" && <>
          <button onClick={() => void run("report", {}, setReport)}>Refresh report</button>
          {report && <><dl>{Object.entries(labels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{aud(report[key])}</dd></div>)}</dl>
            <h4>Latest gift card transactions</h4><History entries={report.events} /></>}
        </>}
      </fieldset>
    </>}
    {message && <p role={isError ? "alert" : "status"}>{message}</p>}
    {!isError && result && <p>{result.barcode || result.service_code}
      {result.stock_count !== undefined && `${result.stock_count} cards registered`}
      {result.after !== undefined && ` · Balance ${aud(result.after)}`}
      {result.redeemed > 0 && result.after === 0 && !result.replacement && " · Fully Redeemed"}
      {result.replacement && ` · ${aud(result.transferred)} transferred to ${result.replacement}`}
    </p>}
  </section>;
}
