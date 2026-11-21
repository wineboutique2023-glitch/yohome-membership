import { useEffect, useRef, useState } from "react";

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
    {payment && <label>Payment method<select name="payment" required><option value="">Select</option>{payments.map((p) => <option key={p}>{p}</option>)}</select></label>}
    {reason && <label>{typeof reason === "string" ? reason : "Reason"}<textarea name="reason" maxLength={1000} required /></label>}
  </>;
}

function ServiceSelect({ services, optional = false, onChange }) {
  return <label>Service<select name="service_code" required={!optional} onChange={onChange}>
    <option value="">{optional ? "Dollar Value" : "Select service"}</option>
    {services.filter((s) => s.active).map((s) => <option key={s.code} value={s.code}>{s.name} · {aud(s.price)}</option>)}
  </select></label>;
}

function History({ entries }) {
  return <div className="gift-history"><table><thead><tr>
    <th>Date</th><th>Action</th><th>Barcode</th><th>Service / payment</th><th>Balance</th><th>Applied / paid</th><th>Details</th>
  </tr></thead><tbody>{entries.map((entry, index) => {
    const { result: data } = entry;
    return <tr key={entry.request_id ?? index}>
      <td>{new Date(entry.created_at).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })}</td>
      <td>{entry.action}</td><td>{data.barcode}{data.replacement && ` → ${data.replacement}`}</td>
      <td>{[data.service_name, data.payment].filter(Boolean).join(" · ")}</td>
      <td>{data.before !== undefined && `${aud(data.before)} → ${aud(data.after)}`}</td>
      <td>{data.redeemed !== undefined && `Applied ${aud(data.redeemed)} · Top-up ${aud(data.topup)}`}{data.cash_sale !== undefined && aud(data.cash_sale)}</td>
      <td>{[data.actor_name, data.reason, data.transferred > 0 && `Transferred ${aud(data.transferred)}`].filter(Boolean).join(" · ")}</td>
    </tr>;
  })}</tbody></table></div>;
}

export default function GiftCards({ client }) {
  const [session, setSession] = useState(null);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, current) => setSession(current));
    return () => data.subscription.unsubscribe();
  }, [client]);

  return session ? <Workspace key={session.user.id} userId={session.user.id} client={client} /> : <SignIn client={client} />;
}

function SignIn({ client }) {
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
  return <section className="panel gift-panel"><h3>Gift card sign-in</h3>
    <form className="form" onSubmit={signIn}>
      <label>Email<input type="email" name="email" autoComplete="username" required /></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {message && <p role="alert">{message}</p>}
  </section>;
}

function Workspace({ client, userId }) {
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
  const [quote, setQuote] = useState(null);
  const [serviceGift, setServiceGift] = useState(false);
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
        if (write && status === 400 && /^(22|23|P0001)/.test(error.code ?? "")) saveRequest(null);
        throw new Error(error.message);
      }
      if (write) {
        saveRequest(null);
        setResult(data);
        setMessage("Saved.");
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
    try {
      if (args.amount !== undefined) args.amount = cents(args.amount);
    } catch (error) {
      setMessage(error.message);
      setIsError(true);
      return;
    }
    void run(action, { ...args, ...extras }, onResult, !["lookup", "quote"].includes(action));
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
    setServiceGift(false);
    setMessage("");
    if (next === "Approvals") void run("pending", {}, setPending);
    if (next === "Reports") void run("report", {}, setReport);
  }

  const owner = overview?.role === "owner";
  const services = overview?.services ?? [];
  const cardServices = card?.kind === "service" && !services.some((s) => s.code === card.service_code && s.active)
    ? [...services.filter((s) => s.code !== card.service_code), {
      code: card.service_code, name: card.service_name, price: card.service_value, active: true,
    }]
    : services;
  const pages = ["Checkout", "Sales", "Legacy Claim"];
  if (owner) pages.push("Approvals", "Card Stock", "Balance Adjustment", "Gift Services", "Reports");

  return <section className="panel gift-panel">
    <div className="gift-actions"><h3>Gift Cards</h3><button type="button" disabled={busy} onClick={() => void client.auth.signOut()}>Sign out</button></div>
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
      <p>Signed in as {overview.name}</p>
      <nav className="gift-actions" aria-label="Gift card functions">{pages.map((name) =>
        <button type="button" key={name} disabled={busy} aria-pressed={page === name} onClick={() => selectPage(name)}>{name}</button>
      )}</nav>
      <fieldset key={page} disabled={busy} className="gift-fields">
        {page === "Checkout" && <>
          <form className="form" onSubmit={(e) => submit(e, "lookup", (value) => { setCard(value); setQuote(null); setResult(null); })}>
            <Fields barcode /><button>Find card</button>
          </form>
          {card && <>
            <p>{card.barcode} · {card.is_expired ? "expired" : card.status} · {aud(card.balance)}
              {card.service_name && ` · ${card.service_name} (${aud(card.service_value)} original value)`}
              {card.expires_on && ` · Expires ${card.expires_on}`}</p>
            {card.status === "active" && !card.is_expired && <>
              <form key={card.barcode} className="form" onSubmit={(e) => submit(e, "quote", setQuote, { barcode: card.barcode })}>
                <ServiceSelect services={cardServices} onChange={() => setQuote(null)} />
                <button>Calculate gift card payment</button>
              </form>
              {quote && <form key={JSON.stringify(quote)} className="form" onSubmit={(e) => {
                const exchange = Boolean(new FormData(e.currentTarget).get("replacement"));
                submit(e, exchange ? "exchange" : "redeem", () => { setCard(null); setQuote(null); },
                  { barcode: card.barcode, service_code: quote.service_code, quote });
              }}>
                <p>{quote.service_name} · Apply {aud(quote.redeemed)} · Customer pays {aud(quote.topup)} · Remaining {aud(quote.after)}</p>
                {quote.service_value_released > 0 && <p>This uses the entire service gift. Unused service value: {aud(quote.service_value_released)}.</p>}
                {quote.topup > 0 && <><Fields payment /><label><input name="payment_confirmed" type="checkbox" value="true" required /> Balance payment received</label></>}
                {card.kind === "legacy" && quote.after > 0 && <>
                  <label>Replacement barcode (leave blank to keep the approved legacy card)<input name="replacement" autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
                  <label><input name="old_card_collected" type="checkbox" value="true" /> Old physical card collected for exchange</label>
                </>}
                <button>Confirm gift card checkout</button>
              </form>}
            </>}
            {card.kind === "legacy" && card.status === "active" && !card.is_expired && !quote && <>
              <h4>Exchange without a purchase</h4>
              <form className="form" onSubmit={transferBalance}>
                <label>New physical card barcode<input name="replacement" autoComplete="off" required
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} /></label>
                <label><input name="old_card_collected" type="checkbox" value="true" required /> Old physical card collected</label>
                <button>Transfer {aud(card.balance)} to new card</button>
              </form>
            </>}
            {card.history.length > 0 && <History entries={card.history} />}
          </>}
        </>}
        {page === "Sales" && <form className="form" onSubmit={(e) => submit(e, "sale")}>
          <Fields barcode />
          <ServiceSelect services={services} optional onChange={(e) => setServiceGift(Boolean(e.target.value))} />
          <Fields amount={!serviceGift && "Card value (AUD)"} expiry payment />
          <button>Record gift card sale</button>
        </form>}
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
            <div className="gift-actions"><button value="approve">Approve</button><button value="reject" formNoValidate>Reject</button></div>
          </form>)}
        </>}
        {page === "Card Stock" && <form className="form" onSubmit={(e) => submit(e, "stock", () => e.target.reset())}>
          <Fields barcode /><button>Register unused physical card</button>
        </form>}
        {page === "Balance Adjustment" && <form className="form" onSubmit={(e) => submit(e, "adjust")}>
          <p>For unused service gifts, enter zero to void the gift. Its original service value is fixed.</p>
          <Fields barcode amount="New balance (AUD)" reason /><button>Save audited adjustment</button>
        </form>}
        {page === "Gift Services" && <>
          <p>Service gifts use these owner-managed prices.</p>
          {services.length > 0 && <ul>{services.map((s) => <li key={s.code}>{s.code} · {s.name} · {aud(s.price)}{!s.active && " · inactive"}</li>)}</ul>}
          <form className="form" onSubmit={(e) => submit(e, "set_service", (data) => {
            setOverview((current) => ({ ...current, services: [
              ...current.services.filter((s) => s.code !== data.service_code),
              { code: data.service_code, name: data.name, price: data.price, active: data.active },
            ] }));
          })}>
            <label>Service code<input name="service_code" required /></label>
            <label>Service name<input name="name" required /></label>
            <Fields amount="Service price (AUD)" />
            <label>Status<select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></label>
            <button>Save gift service</button>
          </form>
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
      {result.after !== undefined && ` · Balance ${aud(result.after)}`}
      {result.replacement && ` · ${aud(result.transferred)} transferred to ${result.replacement}`}
    </p>}
  </section>;
}
