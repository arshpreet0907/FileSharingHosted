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
    auth: { user: SMTP_USER, pass: SMTP_PASS }
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

// ── Helper: send email ────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
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
      return false;
    }
  }

  if (emailBackend === 'resend' && resendClient) {
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

    // Generate OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.createOtp(email, code, expiresAt);

    // Send OTP email
    const sent = await sendEmail(
      email,
      'Your Peer Connect verification code',
      `<p>Your verification code is:</p><h2 style="letter-spacing:4px;font-size:28px;background:#1a1a1a;color:#1D9E75;padding:12px 20px;border-radius:8px;display:inline-block">${code}</h2><p>This code expires in 5 minutes.</p><p>If you did not request this, ignore this email.</p>`
    );

    if (!sent) return res.status(500).json({ error: 'Failed to send verification email. Check server email config.' });

    res.json({ ok: true, message: 'Verification code sent to your email' });
  } catch (err) {
    console.error('[AUTH] Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code, password } = req.body;
    if (!email || !code || !password) return res.status(400).json({ error: 'Email, code, and password required' });

    // Verify OTP
    const valid = db.verifyOtp(email, code);
    if (!valid) return res.status(400).json({ error: 'Invalid or expired verification code' });

    // Hash password and create user
    const hash = bcrypt.hashSync(password, 10);
    db.createUser(email, hash);

    // ── Notify admin about the new registration ─────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const host = req.get('host') || 'localhost';
      const protocol = req.protocol || 'http';
      await sendEmail(
        adminEmail,
        `New registration request: ${email}`,
        `<p>A new user has registered and is awaiting approval:</p>
         <table style="border-collapse:collapse;margin:16px 0;">
           <tr><td style="padding:6px 12px;font-weight:bold;border:1px solid #ccc;">Email</td><td style="padding:6px 12px;border:1px solid #ccc;">${email}</td></tr>
           <tr><td style="padding:6px 12px;font-weight:bold;border:1px solid #ccc;">Time</td><td style="padding:6px 12px;border:1px solid #ccc;">${new Date().toLocaleString()}</td></tr>
         </table>
         <p><a href="${protocol}://${host}/admin.html" style="display:inline-block;padding:10px 20px;background:#1D9E75;color:#fff;text-decoration:none;border-radius:6px;">Review in admin panel →</a></p>`
      );
    }

    res.json({ ok: true, message: 'Registration submitted — awaiting admin approval' });
  } catch (err) {
    console.error('[AUTH] Verify OTP error:', err);
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
