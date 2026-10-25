import bcrypt from "bcryptjs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(PROJECT_DIR, "instance");
const PRODUCTION = process.env.NODE_ENV === "production";
const SECRET = process.env.SESSION_SECRET;
if (PRODUCTION && !SECRET) throw new Error("Set SESSION_SECRET before starting in production.");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(resolve(DATA_DIR, "electricity_app.sqlite3"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
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
`);

db.exec("PRAGMA foreign_keys = ON");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "12kb" }));
app.use(session({
  secret: SECRET || "local-only-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PRODUCTION, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

const python = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
const predictor = resolve(PROJECT_DIR, "predict_usage.py");
const model = resolve(PROJECT_DIR, "models", "electricity_usage_model.joblib");
const usernamePattern = /^[a-z0-9._]{3,32}$/;
const areaTypes = ["Urban", "Semi-Urban", "Rural"];

function csrf(req, res, next) {
  const token = req.get("X-CSRF-Token") || "";
  const expected = req.session.csrfToken || "";
  const left = Buffer.from(token);
  const right = Buffer.from(expected);
  if (!token || left.length !== right.length || !timingSafeEqual(left, right)) {
    return res.status(403).json({ error: "Refresh the page and try again." });
  }
  next();
}

function signedIn(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please sign in first." });
  const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Please sign in first." });
  req.user = user;
  next();
}

function userView(user) {
  return { id: user.id, username: user.username };
}

function startSession(req, userId) {
  return new Promise((resolveSession, rejectSession) => {
    req.session.regenerate((error) => {
      if (error) return rejectSession(error);
      req.session.userId = userId;
      req.session.csrfToken = randomBytes(32).toString("hex");
      req.session.save((saveError) => saveError ? rejectSession(saveError) : resolveSession(req.session.csrfToken));
    });
  });
}

function numberValue(value, label, min, max, whole = false) {
  if (value === "" || value === null || value === undefined) throw new Error(`Enter ${label}.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (whole && !Number.isInteger(number))) {
    throw new Error(`${label} must be ${whole ? "a whole number " : ""}from ${min} to ${max}.`);
  }
  return number;
}

function readPrediction(body) {
  const inputs = {
    Household_Size: numberValue(body.household_size, "family members", 1, 30, true),
    Rooms: numberValue(body.rooms, "rooms", 1, 50, true),
    AC_Units: numberValue(body.ac_units, "air conditioners", 0, 30, true),
    Fan_Count: numberValue(body.fan_count, "fans", 0, 100, true),
    Light_Count: numberValue(body.light_count, "lights", 0, 100, true),
    Refrigerator: numberValue(body.refrigerator, "refrigerators", 0, 1, true),
    TV_Count: numberValue(body.tv_count, "TVs", 0, 30, true),
    Washing_Machine: numberValue(body.washing_machine, "washing machines", 0, 1, true),
    Other_Appliances: numberValue(body.other_appliances, "other appliances", 0, 100, true),
    Previous_Month_Usage_kWh: body.previous_month_usage === "" || body.previous_month_usage == null
      ? null : numberValue(body.previous_month_usage, "previous usage", 0, 50000),
    Temperature_C: numberValue(body.temperature_c, "temperature", -10, 60),
    Area_Type: String(body.area_type || ""),
  };
  if (!areaTypes.includes(inputs.Area_Type)) throw new Error("Choose an area type.");
  const tariff = numberValue(body.tariff_per_kwh, "tariff", 0.01, 1000);
  return { inputs, tariff };
}

function predictUsage(inputs) {
  if (!existsSync(model)) return Promise.reject(new Error("Model not found. Run python train_model.py first."));
  return new Promise((resolvePrediction, rejectPrediction) => {
    const process = spawn(python, [predictor], { cwd: PROJECT_DIR, windowsHide: true });
    let output = "";
    let errors = "";
    process.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    process.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    process.on("error", rejectPrediction);
    process.on("close", (code) => {
      if (code !== 0) return rejectPrediction(new Error(errors.trim() || "Prediction failed."));
      try {
        const result = JSON.parse(output.trim());
        if (!Number.isFinite(result.predicted_kwh)) throw new Error("Model returned an invalid result.");
        resolvePrediction(Math.max(0, result.predicted_kwh));
      } catch (error) {
        rejectPrediction(error);
      }
    });
    process.stdin.end(JSON.stringify(inputs));
  });
}

app.get("/api/csrf-token", (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.prepare("SELECT id, username FROM users WHERE id = ?").get(req.session.userId);
  res.json({ user: user ? userView(user) : null });
});

app.post("/api/auth/register", csrf, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!usernamePattern.test(username)) return res.status(400).json({ error: "Username must be 3-32 letters, numbers, dots, or underscores." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (password !== req.body.confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
  try {
    const createdAt = new Date().toISOString();
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, hash, createdAt);
    const csrfToken = await startSession(req, result.lastInsertRowid);
    res.status(201).json({ user: { id: result.lastInsertRowid, username }, csrfToken });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That username is already registered." });
    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", csrf, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  try {
    const csrfToken = await startSession(req, user.id);
    res.json({ user: userView(user), csrfToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", csrf, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: "Could not sign out." });
    res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: PRODUCTION });
    res.json({ ok: true });
  });
});

app.get("/api/history", signedIn, (req, res) => {
  const rows = db.prepare(`SELECT id, input_json, predicted_kwh, tariff_per_kwh, estimated_bill, created_at
    FROM predictions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(req.user.id);
  res.json({ history: rows.map((row) => ({
    id: row.id,
    inputs: JSON.parse(row.input_json),
    predicted_kwh: row.predicted_kwh,
    tariff_per_kwh: row.tariff_per_kwh,
    estimated_bill: row.estimated_bill,
    created_at: row.created_at,
  })) });
});

app.post("/api/predict", signedIn, csrf, async (req, res) => {
  try {
    const { inputs, tariff } = readPrediction(req.body);
    const predictedKwh = await predictUsage(inputs);
    const estimatedBill = predictedKwh * tariff;
    const createdAt = new Date().toISOString();
    const saved = db.prepare(`INSERT INTO predictions
      (user_id, input_json, predicted_kwh, tariff_per_kwh, estimated_bill, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, JSON.stringify(inputs), predictedKwh, tariff, estimatedBill, createdAt);
    res.json({ prediction: {
      id: saved.lastInsertRowid,
      inputs,
      predicted_kwh: predictedKwh,
      tariff_per_kwh: tariff,
      estimated_bill: estimatedBill,
      created_at: createdAt,
    } });
  } catch (error) {
    if (error instanceof TypeError || error.message.startsWith("Enter ") || error.message.includes("must be") || error.message === "Choose an area type.") {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: "Could not make prediction. Check the trained model and Python setup." });
  }
});

const dist = resolve(PROJECT_DIR, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => console.log(`Server ready at http://${host}:${port}`));
