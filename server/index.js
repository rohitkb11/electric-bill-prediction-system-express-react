import bcrypt from "bcryptjs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTANCE_DIR = resolve(PROJECT_DIR, "instance");
mkdirSync(INSTANCE_DIR, { recursive: true });

const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? "" : "local-development-secret-change-before-deploying");
if (!sessionSecret) throw new Error("Set SESSION_SECRET before running in production.");

const db = new DatabaseSync(resolve(INSTANCE_DIR, "electricity_app.sqlite3"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    input_json TEXT NOT NULL,
    predicted_kwh REAL NOT NULL,
    tariff_per_kwh REAL NOT NULL,
    estimated_bill REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS predictions_by_user ON predictions(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expire);
`);

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.readSession = database.prepare("SELECT sess, expire FROM sessions WHERE sid = ?");
    this.writeSession = database.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`);
    this.updateExpiry = database.prepare("UPDATE sessions SET expire = ? WHERE sid = ?");
    this.deleteSession = database.prepare("DELETE FROM sessions WHERE sid = ?");
    this.expireSessions = database.prepare("DELETE FROM sessions WHERE expire <= ?");
    this.cleanupTimer = setInterval(() => {
      try { this.expireSessions.run(Date.now()); } catch (error) { console.error("Session cleanup failed:", error.message); }
    }, 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = this.readSession.get(sid);
      if (!row || row.expire <= Date.now()) {
        if (row) this.deleteSession.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) { return callback(error); }
  }

  set(sid, value, callback) {
    try {
      this.writeSession.run(sid, JSON.stringify(value), sessionExpiry(value));
      return callback?.(null);
    } catch (error) { return callback?.(error); }
  }

  touch(sid, value, callback) {
    try {
      this.updateExpiry.run(sessionExpiry(value), sid);
      return callback?.(null);
    } catch (error) { return callback?.(error); }
  }

  destroy(sid, callback) {
    try {
      this.deleteSession.run(sid);
      return callback?.(null);
    } catch (error) { return callback?.(error); }
  }
}

function sessionExpiry(value) {
  const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
  return Number.isFinite(expires) ? expires : Date.now() + 7 * 24 * 60 * 60 * 1000;
}

const app = express();
app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(express.json({ limit: "12kb" }));
app.use(session({
  store: new SQLiteSessionStore(db),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

const usernamePattern = /^[a-z0-9._]{3,32}$/;
const areas = new Set(["Urban", "Semi-Urban", "Rural"]);
const pythonExecutable = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
const predictorPath = resolve(PROJECT_DIR, "predict_usage.py");
const modelPath = resolve(PROJECT_DIR, "models", "electricity_usage_model.joblib");

function csrfToken(req, res) {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken });
}

function verifyCsrf(req, res, next) {
  const supplied = req.get("X-CSRF-Token") || "";
  const expected = req.session.csrfToken || "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!supplied || suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(403).json({ error: "Your session expired. Refresh the page and try again." });
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please sign in to continue." });
  const user = db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  req.user = user;
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, created_at: user.created_at };
}

function establishSession(req, userId) {
  return new Promise((resolvePromise, rejectPromise) => {
    req.session.regenerate((error) => {
      if (error) return rejectPromise(error);
      req.session.userId = userId;
      req.session.csrfToken = randomBytes(32).toString("hex");
      req.session.save((saveError) => saveError ? rejectPromise(saveError) : resolvePromise(req.session.csrfToken));
    });
  });
}

function numeric(value, label, minimum, maximum, whole = false) {
  if (value === "" || value === null || value === undefined) throw new Error(`Enter a value for ${label}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  if (whole && !Number.isInteger(parsed)) throw new Error(`${label} must be a whole number.`);
  return whole ? Number.parseInt(parsed, 10) : parsed;
}

function validatePrediction(body) {
  const inputs = {
    Household_Size: numeric(body.household_size, "family members", 1, 30, true),
    Rooms: numeric(body.rooms, "rooms", 1, 50, true),
    AC_Units: numeric(body.ac_units, "air conditioners", 0, 30, true),
    Fan_Count: numeric(body.fan_count, "fans", 0, 100, true),
    Light_Count: numeric(body.light_count, "lights", 0, 100, true),
    Refrigerator: numeric(body.refrigerator, "refrigerator count", 0, 1, true),
    TV_Count: numeric(body.tv_count, "TVs", 0, 30, true),
    Washing_Machine: numeric(body.washing_machine, "washing machine count", 0, 1, true),
    Other_Appliances: numeric(body.other_appliances, "other appliances", 0, 100, true),
    Previous_Month_Usage_kWh: body.previous_month_usage === "" || body.previous_month_usage === null
      ? null
      : numeric(body.previous_month_usage, "previous month's usage", 0, 50000),
    Temperature_C: numeric(body.temperature_c, "temperature", -10, 60),
    Area_Type: String(body.area_type || ""),
  };
  if (!areas.has(inputs.Area_Type)) throw new Error("Select an area type.");
  const tariff = numeric(body.tariff_per_kwh, "tariff per kWh", 0.01, 1000);
  return { inputs, tariff };
}

function predictWithPython(inputs) {
  if (!existsSync(modelPath)) return Promise.reject(new Error("The trained model is missing. Run python train_model.py first."));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonExecutable, [predictorPath], { cwd: PROJECT_DIR, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) return rejectPromise(new Error(diagnostics.trim() || "The prediction process failed."));
      try {
        const result = JSON.parse(output.trim());
        if (!Number.isFinite(result.predicted_kwh)) throw new Error("Invalid model result.");
        resolvePromise(Math.max(0, result.predicted_kwh));
      } catch (error) { rejectPromise(error); }
    });
    child.stdin.end(JSON.stringify(inputs));
  });
}

app.get("/api/csrf-token", csrfToken);
app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(req.session.userId);
  return res.json({ user: user ? publicUser(user) : null });
});

app.post("/api/auth/register", verifyCsrf, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");
  if (!usernamePattern.test(username)) return res.status(400).json({ error: "Use a username of 3–32 letters, numbers, dots, or underscores." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Choose a password with at least 8 characters." });
  if (password !== confirmPassword) return res.status(400).json({ error: "The passwords do not match." });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const createdAt = new Date().toISOString();
    const inserted = db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, passwordHash, createdAt);
    const token = await establishSession(req, inserted.lastInsertRowid);
    return res.status(201).json({ user: { id: inserted.lastInsertRowid, username, created_at: createdAt }, csrfToken: token });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That username is already registered. Please sign in." });
    console.error("Registration failed:", error.message);
    return res.status(500).json({ error: "Account creation failed. Please try again." });
  }
});

app.post("/api/auth/login", verifyCsrf, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  try {
    const token = await establishSession(req, user.id);
    return res.json({ user: publicUser(user), csrfToken: token });
  } catch (error) {
    console.error("Login session failed:", error.message);
    return res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

app.post("/api/auth/logout", verifyCsrf, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: "Could not sign out. Please try again." });
    res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    return res.json({ ok: true });
  });
});

app.get("/api/history", requireUser, (req, res) => {
  const rows = db.prepare(`SELECT id, input_json, predicted_kwh, tariff_per_kwh, estimated_bill, created_at
    FROM predictions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(req.user.id);
  const history = rows.map((row) => ({
    id: row.id,
    inputs: JSON.parse(row.input_json),
    predicted_kwh: row.predicted_kwh,
    tariff_per_kwh: row.tariff_per_kwh,
    estimated_bill: row.estimated_bill,
    created_at: row.created_at,
  }));
  res.json({ history });
});

app.post("/api/predict", requireUser, verifyCsrf, async (req, res) => {
  let validated;
  try { validated = validatePrediction(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const predictedKwh = await predictWithPython(validated.inputs);
    const estimatedBill = predictedKwh * validated.tariff;
    const createdAt = new Date().toISOString();
    const inserted = db.prepare(`INSERT INTO predictions
      (user_id, input_json, predicted_kwh, tariff_per_kwh, estimated_bill, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, JSON.stringify(validated.inputs), predictedKwh, validated.tariff, estimatedBill, createdAt);
    return res.json({ prediction: {
      id: inserted.lastInsertRowid,
      inputs: validated.inputs,
      predicted_kwh: predictedKwh,
      tariff_per_kwh: validated.tariff,
      estimated_bill: estimatedBill,
      created_at: createdAt,
    } });
  } catch (error) {
    console.error("Prediction failed:", error.message);
    return res.status(500).json({ error: "The model could not make a prediction. Check the Python model setup." });
  }
});

const distPath = resolve(PROJECT_DIR, "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("/", (req, res) => res.sendFile(resolve(distPath, "index.html")));
}

app.use((error, req, res, next) => {
  console.error("Request error:", error.message);
  res.status(500).json({ error: "The server could not complete that request." });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");
app.listen(port, host, () => console.log(`Electricity prediction API listening on http://${host}:${port}`));
