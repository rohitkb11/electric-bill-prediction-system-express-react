import { useEffect, useState } from "react";

const blankHome = {
  household_size: "4",
  rooms: "3",
  ac_units: "1",
  fan_count: "4",
  light_count: "6",
  refrigerator: "1",
  tv_count: "1",
  washing_machine: "1",
  other_appliances: "2",
  previous_month_usage: "",
  temperature_c: "30",
  area_type: "Urban",
  tariff_per_kwh: "8.00",
};

const api = async (url, options = {}) => {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetch(url, {
    credentials: "same-origin",
    ...requestOptions,
    headers: { "Content-Type": "application/json", ...headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
};

const money = (value) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
const number = (value, digits = 1) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);

export default function App() {
  const [csrf, setCsrf] = useState("");
  const [user, setUser] = useState(null);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(blankHome);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState("login");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await api("/api/csrf-token");
        if (!active) return;
        setCsrf(token.csrfToken);
        const session = await api("/api/auth/me");
        if (!active || !session.user) return;
        setUser(session.user);
        const data = await api("/api/history");
        if (!active) return;
        setHistory(data.history);
        if (data.history.length) setForm((current) => fromLatest(data.history[0], current));
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    })();
    return () => { active = false; };
  }, []);

  function fromLatest(item, current = blankHome) {
    const inputs = item.inputs;
    return {
      ...current,
      household_size: String(inputs.Household_Size),
      rooms: String(inputs.Rooms),
      ac_units: String(inputs.AC_Units),
      fan_count: String(inputs.Fan_Count),
      light_count: String(inputs.Light_Count),
      refrigerator: String(inputs.Refrigerator),
      tv_count: String(inputs.TV_Count),
      washing_machine: String(inputs.Washing_Machine),
      other_appliances: String(inputs.Other_Appliances),
      temperature_c: String(inputs.Temperature_C),
      area_type: inputs.Area_Type,
      tariff_per_kwh: Number(item.tariff_per_kwh).toFixed(2),
      previous_month_usage: number(item.predicted_kwh, 2),
    };
  }

  async function refreshHistory(prefill = false) {
    const data = await api("/api/history");
    setHistory(data.history);
    if (prefill && data.history.length) setForm((current) => fromLatest(data.history[0], current));
    return data.history;
  }

  async function submitAuth(event) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    const data = new FormData(event.currentTarget);
    const payload = { username: data.get("username"), password: data.get("password") };
    if (authMode === "register") payload.confirmPassword = data.get("confirmPassword");
    try {
      const response = await api(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify(payload),
      });
      setCsrf(response.csrfToken);
      setUser(response.user);
      await refreshHistory(true);
      setMessage(authMode === "register" ? "Account created. Your history starts empty." : `Welcome back, ${response.user.username}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError("");
    try {
      await api("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrf }, body: "{}" });
      setUser(null); setHistory([]); setResult(null); setForm(blankHome); setMessage("You have been signed out.");
      const token = await api("/api/csrf-token"); setCsrf(token.csrfToken);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function predict(event) {
    event.preventDefault(); setBusy(true); setError(""); setMessage(""); setResult(null);
    try {
      const response = await api("/api/predict", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify(form),
      });
      setResult(response.prediction);
      await refreshHistory(false);
      setMessage("Your estimate was saved to your account history.");
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Current home"><span className="brand-mark">ϟ</span><span>current<span className="brand-dot">.</span></span></a>
        {user ? <div className="topbar-right"><span className="welcome">Hi, {user.username}</span><button className="logout-button" onClick={signOut} disabled={busy}>Sign out <span>↗</span></button></div> : <span className="top-link">HOUSEHOLD ENERGY ESTIMATOR</span>}
      </header>

      {(message || error) && <div className={`notice ${error ? "notice-error" : "notice-success"}`} role="status">{error || message}<button onClick={() => { setError(""); setMessage(""); }} aria-label="Dismiss message">×</button></div>}

      {!user ? (
        <AuthPanel mode={authMode} setMode={setAuthMode} onSubmit={submitAuth} busy={busy} />
      ) : (
        <>
          <section className="dashboard-heading">
            <div><p className="eyebrow"><span className="eyebrow-line" /> YOUR HOUSEHOLD DASHBOARD</p><h1>Make energy<br /><span>feel predictable.</span></h1><p className="dashboard-intro">A simple estimate, shaped around your home.</p></div>
            <div className="heading-stat"><div className="stat-icon">ϟ</div><div><span className="stat-label">YOUR SAVED ESTIMATES</span><strong>{history.length}<small> / 20 recent</small></strong></div></div>
          </section>

          {result && <section className="result-banner" aria-live="polite"><div className="result-symbol">✓</div><div className="result-main"><span className="result-label">NEW MONTHLY ESTIMATE · {new Date(result.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span><strong>{number(result.predicted_kwh)} <small>kWh</small></strong><span className="result-caption">Estimated household electricity use</span></div><div className="result-divider" /><div className="bill-result"><span className="result-label">ESTIMATED BILL</span><strong>₹{money(result.estimated_bill)}</strong><span className="result-caption">at ₹{number(result.tariff_per_kwh, 2)} per kWh</span></div><button className="result-dismiss" onClick={() => setResult(null)} aria-label="Dismiss estimate">×</button></section>}

          <div className="dashboard-grid">
            <section className="form-card">
              <div className="card-heading"><div><p className="card-eyebrow">01 <span>·</span> HOME PROFILE</p><h2>Tell us about your home</h2><p className="card-subtitle">A few details help the model make an estimate.</p></div><span className="step-pill">ABOUT 1 MIN</span></div>
              <form className="prediction-form" onSubmit={predict}>
                <div className="form-section-label"><span className="section-icon">⌂</span> HOME &amp; PEOPLE</div>
                <div className="field-grid field-grid-3">
                  <Field label="Family members" name="household_size" value={form.household_size} onChange={updateField} min="1" max="30" suffix="people" />
                  <Field label="Rooms" name="rooms" value={form.rooms} onChange={updateField} min="1" max="50" suffix="rooms" />
                  <div className="field"><label htmlFor="area_type">Area type</label><select id="area_type" name="area_type" value={form.area_type} onChange={updateField}><option>Urban</option><option>Semi-Urban</option><option>Rural</option></select></div>
                </div>
                <div className="form-section-label appliance-label"><span className="section-icon">ϟ</span> APPLIANCES</div>
                <div className="field-grid field-grid-4">
                  <Field label="Air conditioners" name="ac_units" value={form.ac_units} onChange={updateField} max="30" />
                  <Field label="Fans" name="fan_count" value={form.fan_count} onChange={updateField} max="100" />
                  <Field label="Lights" name="light_count" value={form.light_count} onChange={updateField} max="100" />
                  <Field label="TVs" name="tv_count" value={form.tv_count} onChange={updateField} max="30" />
                  <BoolField label="Refrigerator" name="refrigerator" value={form.refrigerator} onChange={updateField} />
                  <BoolField label="Washing machine" name="washing_machine" value={form.washing_machine} onChange={updateField} />
                  <Field label="Other appliances" name="other_appliances" value={form.other_appliances} onChange={updateField} max="100" suffix="count" />
                  <Field label="Typical temperature" name="temperature_c" value={form.temperature_c} onChange={updateField} min="-10" max="60" step="0.1" suffix="°C" />
                </div>
                <div className="field-grid field-grid-2 last-fields">
                  <div className="field"><label htmlFor="previous_month_usage">Previous month's usage <span className="optional">optional</span></label><div className="input-suffix"><input id="previous_month_usage" name="previous_month_usage" type="number" min="0" max="50000" step="0.1" value={form.previous_month_usage} onChange={updateField} placeholder="Leave blank if unknown" /><span>kWh</span></div><small className="field-hint">{history.length ? "Started with your last saved estimate. Replace it with a meter reading if you have one." : "Leave blank if you don't know it; the model will impute a typical value."}</small></div>
                  <div className="field"><label htmlFor="tariff_per_kwh">Your electricity tariff</label><div className="input-prefix"><span>₹</span><input id="tariff_per_kwh" name="tariff_per_kwh" type="number" min="0.01" max="1000" step="0.01" required value={form.tariff_per_kwh} onChange={updateField} /><span className="unit">/ kWh</span></div><small className="field-hint">Use the per-unit rate from your latest bill.</small></div>
                </div>
                <div className="form-actions"><p>Bill estimate = predicted kWh × your tariff</p><button type="submit" className="button button-primary predict-button" disabled={busy}>{busy ? "Estimating…" : <>Estimate my bill <span>→</span></>}</button></div>
              </form>
            </section>

            <aside className="side-column">
              <section className="history-card"><div className="history-heading"><div><p className="card-eyebrow">02 <span>·</span> YOUR ACTIVITY</p><h2>Recent estimates</h2></div><span className="history-count">{history.length}</span></div>
                {history.length ? <div className="history-list">{history.map((item) => <article className={`history-item ${result?.id === item.id ? "history-item-current" : ""}`} key={item.id}><div className="history-date"><span className="history-dot" />{new Date(item.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}<small>{new Date(item.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</small></div><div className="history-values"><strong>{money(item.predicted_kwh)} <small>kWh</small></strong><span>₹{money(item.estimated_bill)}</span></div><div className="history-home">{item.inputs.Household_Size} people <span>·</span> {item.inputs.AC_Units} AC <span>·</span> {item.inputs.Area_Type}</div></article>)}</div> : <div className="empty-history"><div className="empty-icon">⌁</div><h3>Your history starts here</h3><p>Once you make an estimate, it will be saved here for your next visit.</p><span className="empty-line" /><small>PRIVATE TO YOUR ACCOUNT</small></div>}
              </section>
              <section className="model-note"><span className="model-note-icon">i</span><div><strong>A classroom estimate</strong><p>The model was trained on a Kaggle household dataset from Bangladesh. Your tariff is applied in rupees; local utility slabs and fixed charges are not included.</p></div></section>
            </aside>
          </div>
        </>
      )}
      <footer className="site-footer"><span>Current <span className="brand-dot">•</span> household energy estimate</span><span>Learning project · estimates are not utility bills</span></footer>
    </div>
  );
}

function AuthPanel({ mode, setMode, onSubmit, busy }) {
  const registering = mode === "register";
  return <section className="auth-layout"><div className="auth-copy"><p className="eyebrow"><span className="eyebrow-line" /> {registering ? "A FRESH START FOR YOUR HOME" : "ELECTRICITY, MADE CLEARER"}</p><h1>{registering ? <>Your energy<br />story starts <span>here.</span></> : <>Get a feel for<br />your monthly <span>energy.</span></>}</h1><p className="auth-description">{registering ? "Create a private account to save your household details and keep a useful history of estimates." : "Estimate household electricity use from the people, rooms and appliances that make your home yours."}</p><div className="auth-note"><span className="note-icon">{registering ? "✳" : "↗"}</span><span><strong>{registering ? "New account, clean slate." : "One home at a time."}</strong><br />{registering ? "Your history begins with your first estimate." : "Your saved estimates stay with your account."}</span></div><div className="orb orb-one" /><div className="orb orb-two" /></div>
    <div className="auth-panel"><div className="panel-kicker">{registering ? "GET STARTED" : "WELCOME BACK"}</div><h2>{registering ? "Create account" : "Sign in"}</h2><p className="panel-subtitle">{registering ? "It takes less than a minute." : "Pick up where your household left off."}</p><form className="auth-form" onSubmit={onSubmit}><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required minLength="3" maxLength="32" placeholder="3–32 characters" /><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete={registering ? "new-password" : "current-password"} required minLength={registering ? "8" : undefined} placeholder={registering ? "At least 8 characters" : "Your password"} />{registering && <><label htmlFor="confirmPassword">Confirm password</label><input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength="8" placeholder="Enter it once more" /></>}<button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : registering ? <>Create my account <span>→</span></> : <>Sign in <span>→</span></>}</button></form><p className="auth-switch">{registering ? "Already have an account?" : "New to Current?"} <button onClick={() => setMode(registering ? "login" : "register")}>{registering ? "Sign in" : "Create an account"} <span>↗</span></button></p><div className="auth-smallprint">Your password is stored as a secure hash.</div></div>
  </section>;
}

function Field({ label, name, value, onChange, min = "0", max, step = "1", suffix }) {
  return <div className="field"><label htmlFor={name}>{label}</label>{suffix ? <div className="input-suffix"><input id={name} name={name} type="number" min={min} max={max} step={step} required value={value} onChange={onChange} /><span>{suffix}</span></div> : <input id={name} name={name} type="number" min={min} max={max} step={step} required value={value} onChange={onChange} />}</div>;
}

function BoolField({ label, name, value, onChange }) {
  return <div className="field"><label htmlFor={name}>{label}</label><select id={name} name={name} value={value} onChange={onChange}><option value="1">Yes</option><option value="0">No</option></select></div>;
}
