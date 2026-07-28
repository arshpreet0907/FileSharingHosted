// ── auth.js — Authentication routes ────────────────────────────────────
const express    = require('express');
const bcrypt     = require('bcrypt');
const nodemailer = require('nodemailer');
const router     = express.Router();
const db         = require('./db');

// ── Email configuration ───────────────────────────────────────────────
// Priority: Nodemailer (SMTP) > Resend (toggleable)
// Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to use Nodemailer.
// If those are unset, set RESEND_API_KEY to use Resend instead.
const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Peer Connect <noreply@peerconnect.app>';

let transporter = null;
let resendClient = null;
let emailBackend = null; // 'smtp', 'resend', or null

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,   // fail fast if Gmail blocks the cloud IP (10s)
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: { rejectUnauthorized: false }  // needed from some cloud environments
  });
  emailBackend = 'smtp';
  console.log(`[EMAIL] Using Nodemailer (SMTP): ${SMTP_HOST}:${SMTP_PORT}`);
} else if (RESEND_API_KEY) {
  const { Resend } = require('resend');
  resendClient = new Resend(RESEND_API_KEY);
  emailBackend = 'resend';
  console.log('[EMAIL] Using Resend');
} else {
  console.warn('[EMAIL] No email backend configured — set SMTP_* vars or RESEND_API_KEY');
}

// ── Helper: send email (SMTP primary, Resend fallback) ────────────────
async function sendEmail(to, subject, html) {
  // Try SMTP first
  if (emailBackend === 'smtp' && transporter) {
    try {
      const info = await transporter.sendMail({
        from: EMAIL_FROM,
        to,
        subject,
        html
      });
      console.log(`[EMAIL] Sent to ${to} via SMTP — id=${info.messageId || 'unknown'}`);
      return true;
    } catch (err) {
      console.error('[EMAIL] SMTP failed:', err.message);
      // If Resend is available, fall back automatically
      if (resendClient) {
        console.log('[EMAIL] Falling back to Resend…');
        emailBackend = 'resend';
        return sendEmail(to, subject, html);
      }
      return false;
    }
  }

  // Try Resend (primary if no SMTP, or fallback from SMTP)
  if (resendClient) {
    try {
      const { id: emailId } = await resendClient.emails.send({
        from: EMAIL_FROM,
        to,
        subject,
        html
      });
      console.log(`[EMAIL] Sent to ${to} via Resend — id=${emailId || 'unknown'}`);
      return true;
    } catch (err) {
      console.error('[EMAIL] Resend failed:', err.message);
      return false;
    }
  }

  console.error(`[EMAIL] FAILED: No email backend configured (to=${to}). Set SMTP_* vars or RESEND_API_KEY.`);
  return false;
}

// ── Middleware: require authenticated session ──────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.peer_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.getSession(token);
  if (!session) {
    res.clearCookie('peer_session');
    return res.status(401).json({ error: 'Session expired' });
  }
  // Sliding expiry — refresh on activity
  db.refreshSession(token);
  req.user = { email: session.email };
  next();
}

// ── Middleware: require admin ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return res.status(403).json({ error: 'No admin configured' });
  if (req.user.email !== adminEmail) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── POST /api/auth/register ────────────────────────────────────────────
// Single-step: email + password → create pending user (no email/OTP required)
// OTP / email verification is reserved for future use once a verified
// sending domain is configured (see sendEmail below).
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Check duplicate
    const existing = db.getUserByEmail(email);
    if (existing) {
      if (existing.status === 'pending') return res.status(400).json({ error: 'Registration already submitted — awaiting approval' });
      if (existing.status === 'approved') return res.status(400).json({ error: 'Account already exists — please log in' });
      if (existing.status === 'declined') return res.status(400).json({ error: 'Your registration was declined. Contact admin.' });
    }

    // Hash password and create user directly (no OTP step)
    const hash = bcrypt.hashSync(password, 10);
    db.createUser(email, hash);

    res.json({ ok: true, message: 'Registration submitted — awaiting admin approval' });
  } catch (err) {
    console.error('[AUTH] Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'No account found with this email' });

    if (user.status === 'pending') return res.status(400).json({ error: 'Your registration is awaiting admin approval' });
    if (user.status === 'declined') return res.status(400).json({ error: 'Your registration was declined' });
    if (user.status !== 'approved') return res.status(400).json({ error: 'Account not approved' });

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect password' });

    // Create session
    const token = db.createSession(email);

    // Set HTTP-only cookie (secure in production)
    const isSecure = process.env.NODE_ENV === 'production';
    res.cookie('peer_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ ok: true, email, isAdmin: email === (process.env.ADMIN_EMAIL || '') });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const token = req.cookies?.peer_session;
  if (token) {
    db.deleteSession(token);
    res.clearCookie('peer_session');
  }
  res.json({ ok: true });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const adminEmail = process.env.ADMIN_EMAIL || '';
  res.json({
    email: req.user.email,
    isAdmin: req.user.email === adminEmail
  });
});

module.exports = { router, requireAuth, requireAdmin, sendEmail };
