// ── db.js — SQLite database layer (sql.js / WASM, no native deps) ─────
const initSqlJs = require('sql.js');
const bcrypt    = require('bcrypt');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'peerconnect.db');

let db;

// ── Helper wrappers to match better-sqlite3's synchronous API ─────────

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  let row;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function dbAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  stmt.step();
  stmt.free();
}

// ── Persist in-memory DB to disk ──────────────────────────────────────
function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ── Initialise (async — loads WASM binary) ──────────────────────────
async function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  // Load existing DB from disk or create a new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL,
      password_hash TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS otps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL,
      code       TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      email      TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);
  `);

  // Auto-create admin from env vars
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass  = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPass) {
    const existing = dbGet('SELECT * FROM users WHERE email = ?', [adminEmail]);
    if (!existing) {
      const hash = bcrypt.hashSync(adminPass, 10);
      dbRun('INSERT INTO users (email, password_hash, status) VALUES (?, ?, ?)', [adminEmail, hash, 'approved']);
      console.log(`[DB] Admin account created: ${adminEmail}`);
    } else if (existing.status !== 'approved') {
      dbRun('UPDATE users SET status = ? WHERE email = ?', ['approved', adminEmail]);
      console.log(`[DB] Admin account updated to approved: ${adminEmail}`);
    }
  }

  // Periodic session cleanup + save DB to disk (every hour)
  setInterval(() => {
    dbRun("DELETE FROM sessions WHERE expires_at < datetime('now')");
    saveDb();
  }, 60 * 60 * 1000);

  console.log('[DB] Initialised');
  return db;
}

// ── Users ──────────────────────────────────────────────────────────────
function createUser(email, passwordHash) {
  dbRun('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
  saveDb();
}

function getUserByEmail(email) {
  return dbGet('SELECT * FROM users WHERE email = ?', [email]);
}

function setUserStatus(email, status) {
  dbRun('UPDATE users SET status = ? WHERE email = ?', [status, email]);
  saveDb();
}

function getPendingUsers() {
  return dbAll('SELECT id, email, created_at FROM users WHERE status = ? ORDER BY created_at ASC', ['pending']);
}

function getAllUsers() {
  return dbAll('SELECT id, email, status, created_at FROM users ORDER BY created_at DESC');
}

// ── OTPs ───────────────────────────────────────────────────────────────
function createOtp(email, code, expiresAt) {
  // Invalidate old unused OTPs for this email
  dbRun('UPDATE otps SET used = 1 WHERE email = ? AND used = 0', [email]);
  dbRun('INSERT INTO otps (email, code, expires_at) VALUES (?, ?, ?)', [email, code, expiresAt]);
  saveDb();
}

function verifyOtp(email, code) {
  const otp = dbGet(
    "SELECT * FROM otps WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1",
    [email, code]
  );
  if (!otp) return false;
  dbRun('UPDATE otps SET used = 1 WHERE id = ?', [otp.id]);
  saveDb();
  return true;
}

// ── Sessions ───────────────────────────────────────────────────────────
function generateSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

function createSession(email) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  dbRun('INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, ?)', [token, email, expiresAt]);
  saveDb();
  return token;
}

function getSession(token) {
  return dbGet(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')",
    [token]
  );
}

function refreshSession(token) {
  const newExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  dbRun('UPDATE sessions SET expires_at = ? WHERE token = ?', [newExpires, token]);
  saveDb();
}

function deleteSession(token) {
  dbRun('DELETE FROM sessions WHERE token = ?', [token]);
  saveDb();
}

function deleteExpiredSessions() {
  dbRun("DELETE FROM sessions WHERE expires_at < datetime('now')");
  saveDb();
}

module.exports = {
  initDb,
  createUser, getUserByEmail, setUserStatus, getPendingUsers, getAllUsers,
  createOtp, verifyOtp,
  createSession, getSession, refreshSession, deleteSession, deleteExpiredSessions
};
