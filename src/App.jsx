import { useEffect, useState } from "react";

const emptyForm = {
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
  tariff_per_kwh: "8",
};

const numberFields = [
  ["household_size", "Family members", 1, 30, 1],
  ["rooms", "Rooms", 1, 50, 1],
  ["ac_units", "Air conditioners", 0, 30, 1],
  ["fan_count", "Fans", 0, 100, 1],
  ["light_count", "Lights", 0, 100, 1],
  ["tv_count", "TVs", 0, 30, 1],
  ["other_appliances", "Other appliances", 0, 100, 1],
  ["temperature_c", "Temperature (C)", -10, 60, 0.1],
];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);
}

function formFromHistory(item) {
  const x = item.inputs;
  return {
    household_size: String(x.Household_Size),
    rooms: String(x.Rooms),
    ac_units: String(x.AC_Units),
    fan_count: String(x.Fan_Count),
    light_count: String(x.Light_Count),
    refrigerator: String(x.Refrigerator),
    tv_count: String(x.TV_Count),
    washing_machine: String(x.Washing_Machine),
    other_appliances: String(x.Other_Appliances),
    previous_month_usage: String(item.predicted_kwh),
    temperature_c: String(x.Temperature_C),
    area_type: x.Area_Type,
    tariff_per_kwh: String(item.tariff_per_kwh),
  };
}

export default function App() {
  const [user, setUser] = useState(null);
  const [csrf, setCsrf] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [form, setForm] = useState(emptyForm);
  const [history, setHistory] = useState([]);
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadAccount() {
      try {
        const token = await api("/api/csrf-token");
        const session = await api("/api/auth/me");
        if (!active) return;
        setCsrf(token.csrfToken);
        setUser(session.user);
        if (session.user) {
          const data = await api("/api/history");
          if (!active) return;
          setHistory(data.history);
          if (data.history.length) setForm(formFromHistory(data.history[0]));
        }
      } catch (requestError) {
        if (active) setError(requestError.message);
      }
    }
    loadAccount();
    return () => { active = false; };
  }, []);

  function updateForm(event) {
    setForm({ ...form, [event.target.name]: event.target.value });
  }

  async function loadHistory() {
    const data = await api("/api/history");
    setHistory(data.history);
  }

  async function submitAuth(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const values = new FormData(event.currentTarget);
    const payload = {
      username: values.get("username"),
      password: values.get("password"),
    };
    if (authMode === "register") payload.confirmPassword = values.get("confirmPassword");

    try {
      const data = await api(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify(payload),
      });
      setUser(data.user);
      setCsrf(data.csrfToken);
      const rows = await api("/api/history");
      setHistory(rows.history);
      if (rows.history.length) setForm(formFromHistory(rows.history[0]));
      setNotice(authMode === "register" ? "Account created. Your history is empty." : "Signed in.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: "{}",
      });
      const token = await api("/api/csrf-token");
      setCsrf(token.csrfToken);
      setUser(null);
      setHistory([]);
      setResult(null);
      setForm(emptyForm);
      setNotice("Signed out.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function predict(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const data = await api("/api/predict", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify(form),
      });
      setResult(data.prediction);
      await loadHistory();
      setNotice("Estimate saved to your history.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Electricity Bill Predictor</h1>
        {user && <div className="account"><span>{user.username}</span><button className="secondary" onClick={signOut} disabled={busy}>Sign out</button></div>}
      </header>

      {error && <p className="message error" role="alert">{error}</p>}
      {notice && <p className="message success" role="status">{notice}</p>}

      {!user ? (
        <section className="card auth-card">
          <h2>{authMode === "login" ? "Sign in" : "Create an account"}</h2>
          <p>Sign in to make predictions and save your history.</p>
          <form onSubmit={submitAuth} className="auth-form">
            <label>Username<input name="username" minLength="3" maxLength="32" required autoComplete="username" /></label>
            <label>Password<input name="password" type="password" minLength={authMode === "register" ? 8 : undefined} required autoComplete={authMode === "register" ? "new-password" : "current-password"} /></label>
            {authMode === "register" && <label>Confirm password<input name="confirmPassword" type="password" minLength="8" required autoComplete="new-password" /></label>}
            <button className="primary" disabled={busy}>{busy ? "Please wait..." : authMode === "login" ? "Sign in" : "Create account"}</button>
          </form>
          <button className="link-button" onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>
            {authMode === "login" ? "Need an account? Register" : "Already registered? Sign in"}
          </button>
        </section>
      ) : (
        <div className="columns">
          <section className="card">
            <h2>Home details</h2>
            <p>Enter household and appliance counts to estimate monthly electricity use.</p>
            <form onSubmit={predict}>
              <div className="form-grid">
                {numberFields.map(([name, label, min, max, step]) => (
                  <label key={name}>{label}<input name={name} type="number" min={min} max={max} step={step} value={form[name]} onChange={updateForm} required /></label>
                ))}
                <label>Refrigerators<select name="refrigerator" value={form.refrigerator} onChange={updateForm}><option value="0">0</option><option value="1">1</option></select></label>
                <label>Washing machines<select name="washing_machine" value={form.washing_machine} onChange={updateForm}><option value="0">0</option><option value="1">1</option></select></label>
                <label>Area type<select name="area_type" value={form.area_type} onChange={updateForm}><option>Urban</option><option>Semi-Urban</option><option>Rural</option></select></label>
                <label>Previous month usage (optional)<input name="previous_month_usage" type="number" min="0" max="50000" step="0.1" value={form.previous_month_usage} onChange={updateForm} placeholder="Leave blank if unknown" /></label>
                <label>Tariff per kWh (₹)<input name="tariff_per_kwh" type="number" min="0.01" max="1000" step="0.01" value={form.tariff_per_kwh} onChange={updateForm} required /></label>
              </div>
              <button className="primary predict-button" disabled={busy}>{busy ? "Calculating..." : "Predict usage and bill"}</button>
            </form>
          </section>

          <aside>
            {result && <section className="card result">
              <h2>Prediction</h2>
              <p><strong>{formatNumber(result.predicted_kwh)} kWh</strong> estimated monthly use</p>
              <p><strong>₹{formatNumber(result.estimated_bill, 2)}</strong> estimated bill</p>
              <small>Calculated using your tariff of ₹{formatNumber(result.tariff_per_kwh, 2)} per kWh.</small>
            </section>}
            <section className="card">
              <h2>Recent history</h2>
              {history.length === 0 ? <p>No predictions yet. Your history will appear here.</p> : (
                <ul className="history">
                  {history.map((item) => <li key={item.id}>
                    <span>{new Date(item.created_at).toLocaleDateString()}</span>
                    <strong>{formatNumber(item.predicted_kwh)} kWh</strong>
                    <span>₹{formatNumber(item.estimated_bill, 2)}</span>
                  </li>)}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}
      <footer>Household electricity estimate</footer>
    </main>
  );
}
