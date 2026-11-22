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

function ServiceSelect({ services, onChange }) {
  return <label>Service<select name="service_code" required onChange={onChange}>
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
      <td>{[data.actor_name, data.reason,
        Object.hasOwn(data, "registration_note") && `Note: ${data.previous_note ?? "—"} → ${data.registration_note ?? "—"}`,
        data.transferred > 0 && `Transferred ${aud(data.transferred)}`].filter(Boolean).join(" · ")}</td>
    </tr>;
  })}</tbody></table></div>;
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
  const [saleType, setSaleType] = useState("dollar");
  const [saleFamily, setSaleFamily] = useState("");
  const [saleService, setSaleService] = useState("");
  const [saleValue, setSaleValue] = useState("");
  const [manageAction, setManageAction] = useState("");
  const [pending, setPending] = useState(null);
  const [report, setReport] = useState(null);
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

  function selectPage(next) {
    if (request) {
      setMessage("Retry the previous submission before leaving this page.");
      setIsError(true);
      return;
    }
    setPage(next);
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
    if (next === "Approvals") void run("pending", {}, setPending);
    if (next === "Reports") void run("report", {}, setReport);
  }

  const owner = ownerView && overview?.role === "owner";
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
        <h4>{pageLabels[page] ?? page}</h4>
        {page === "Checkout" && <>
          <form className="form" onSubmit={(e) => {
            setCard(null);
            setQuote(null);
            setResult(null);
            setMissingBarcode("");
            setClaimOld(false);
            submit(e, "lookup", setCard);
          }}>
            <label>Scan Gift Card Barcode<input name="barcode" autoComplete="off" required
              onChange={() => { setCard(null); setQuote(null); setMissingBarcode(""); setClaimOld(false); }}
              onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.form.requestSubmit();
            }} /></label><button>Find card</button>
          </form>
          {missingBarcode && <>
            <label><input type="checkbox" checked={claimOld} onChange={(e) => setClaimOld(e.target.checked)} /> Existing Old Gift Card</label>
            {claimOld && <form className="form" onSubmit={(e) => submit(e, "claim",
              () => { setMissingBarcode(""); setClaimOld(false); }, { barcode: missingBarcode })}>
              <p>Old card: {missingBarcode}</p>
              <Fields amount="Claimed old card value (AUD)" reason="Evidence or old card details" />
              <button>Submit for owner approval</button>
            </form>}
          </>}
          {card && <>
            <p>{card.barcode} · {card.is_expired ? "expired" : card.status === "spent" ? "Fully Redeemed" : card.status} · {aud(card.balance)}
              {card.service_name && ` · ${card.service_name} (${aud(card.service_value)} original value)`}
              {card.expires_on && ` · Expires ${card.expires_on}`}</p>
            {card.status === "active" && !card.is_expired && <>
              <form key={card.barcode} className="form" onSubmit={(e) => {
                if (e.nativeEvent.submitter?.value === "quote") {
                  const fields = new FormData(e.currentTarget);
                  e.preventDefault();
                  if (!fields.get("service_code")) {
                    setMessage("Select a service.");
                    setIsError(true);
                    return;
                  }
                  const args = { barcode: card.barcode, service_code: fields.get("service_code") };
                  try {
                    if (fields.get("redeem_amount")) args.redeem_amount = cents(fields.get("redeem_amount"));
                  } catch (error) {
                    setMessage(error.message);
                    setIsError(true);
                    return;
                  }
                  void run("quote", args, setQuote);
                  return;
                }
                e.preventDefault();
                if (!quote) return;
                const exchange = Boolean(new FormData(e.currentTarget).get("replacement"));
                submit(e, exchange ? "exchange" : "redeem", () => { setCard(null); setQuote(null); },
                  { barcode: card.barcode, service_code: quote.service_code, quote,
                    ...(card.kind === "dollar" && { redeem_amount: quote.redeemed }) });
              }}>
                <ServiceSelect services={cardServices} onChange={() => setQuote(null)} />
                <label>Therapist<select name="therapist" required>
                  <option value="">Select</option>
                  {sellers.map((name) => <option key={name}>{name}</option>)}
                </select></label>
                <label>Service Date<input name="checkout_date" type="date" defaultValue={serviceDate} required /></label>
                {card.kind === "dollar" ? <label>Redeem Amount (AUD)
                  <input name="redeem_amount" inputMode="decimal" placeholder="Leave blank to apply available balance" onChange={() => setQuote(null)} />
                </label> : <label>Redeem Amount (AUD)<input value={quote ? aud(quote.redeemed) : ""} readOnly /></label>}
                {quote?.topup > 0 ? <Fields payment /> : <label>Payment Method<input value="Gift Card" readOnly /></label>}
                <div className="priceBox">
                  <p>Service Price: {quote ? aud(quote.service_price) : "—"}</p>
                  <p>Gift Card Applied: {quote ? aud(quote.redeemed) : "—"}</p>
                  <p>Remaining Balance: {aud(quote?.after ?? card.balance)}</p>
                  <p>Customer Pays: {quote ? aud(quote.topup) : "—"}</p>
                </div>
                {quote?.service_value_released > 0 && <>
                  <p>Unused service gift value: <strong>{aud(quote.service_value_released)}</strong>. The entire gift will be used.</p>
                  <label><input name="unused_value_confirmed" type="checkbox" value="true" required /> Customer confirmed they accept forfeiting this unused value</label>
                </>}
                {quote?.topup > 0 && <label><input name="payment_confirmed" type="checkbox" value="true" required /> Balance payment received</label>}
                {card.kind === "legacy" && quote?.after > 0 && <>
                  <label>Replacement barcode (leave blank to keep the approved legacy card)<input name="replacement" autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
                  <label><input name="old_card_collected" type="checkbox" value="true" /> Old physical card collected for exchange</label>
                </>}
                <div className="gift-actions">
                  <button value="quote" formNoValidate>Calculate gift card payment</button>
                  <button className="primary" disabled={!quote}>Confirm Checkout</button>
                </div>
              </form>
            </>}
            {card.kind === "legacy" && card.status === "active" && !card.is_expired && !quote && <>
              <h4>Replace Old Card</h4>
              <form className="form" onSubmit={transferBalance}>
                <label>New physical card barcode<input name="replacement" autoComplete="off" required
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
                <label><input name="old_card_collected" type="checkbox" value="true" required /> Old physical card collected</label>
                <button>Replace Old Card · {aud(card.balance)}</button>
              </form>
            </>}
            {card.history.length > 0 && <><h4>Card History</h4><History entries={card.history} /></>}
          </>}
        </>}
        {owner && page === "Manage Gift Cards" && <>
          <form className="form" onSubmit={(e) => submit(e, "manage_lookup", (value) => { setCard(value); setManageAction(""); })}>
            <label>Barcode<input name="barcode" type="search" autoComplete="off" required /></label>
            <button>Find Card</button>
          </form>
          {card && <div className="gift-card-detail" key={card.barcode}>
            <h4>{card.barcode}</h4>
            <p>{card.kind} · {card.status}{card.is_expired && " · expired"} · {aud(card.balance)}
              {card.expires_on && ` · Expires ${card.expires_on}`}</p>
            {card.service_name && <p>{serviceLabel({
              name: card.service_name, duration: card.service_duration, price: card.service_value,
            })}</p>}
            {owner && <div className="gift-actions">
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
              <p>Cancelling stops future use. Any payment already recorded stays in the reports.</p>
              <Fields reason="Reason for cancellation" />
              <label><input type="checkbox" required /> Confirm this card should be cancelled</label>
              <button className="danger">Cancel Card</button>
            </form>}
            <h4>Card History</h4>
            {card.history.length ? <History entries={card.history} /> : <p>No activity yet.</p>}
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
          <Fields barcode amount="Claimed old card value (AUD)" reason="Evidence or old card details" />
          <button>Submit for owner approval</button>
        </form>}
        {page === "Approvals" && <>
          <button onClick={() => void run("pending", {}, setPending)}>Refresh claims</button>
          {pending?.length === 0 && <p>No pending claims.</p>}
          {pending?.map((item) => <form className="form gift-review" key={item.barcode} onSubmit={(e) => {
            const action = e.nativeEvent.submitter.value;
            submit(e, action, () => setPending((current) => current.filter((c) => c.barcode !== item.barcode)), { barcode: item.barcode });
          }}>
            <p>{item.barcode} · Claimed {aud(item.claim.claimed)} · {item.claim.actor_name}</p>
            <p>{item.claim.reason}</p>
            <Fields amount="Approved balance (AUD)" expiry reason="Review reason" />
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
