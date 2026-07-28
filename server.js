require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const cookieParser = require('cookie-parser');

const db       = require('./db');
const { router: authRoutes, requireAuth, requireAdmin, sendEmail } = require('./auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  pingInterval: 10000,
  pingTimeout:  5000,
  cors: { origin: true, credentials: true }
});

// ─── Middleware (before async init so routes are registered early) ─────
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory state ─────────────────────────────────────────────────

// email → socketId
const peers = new Map();
// socketId → email
const socketToPeer = new Map();
// roomId → { peerA, peerB, state, suspendedPeer, graceTimer, messageBuffer }
const rooms = new Map();

const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ─────────────────────────────────────────────────────────

function getRoomId(peerA, peerB) {
  return [peerA, peerB].sort().join(':');
}

function findRoomForPeer(email) {
  for (const [, room] of rooms) {
    if (room.peerA === email || room.peerB === email) return room;
  }
  return null;
}

function otherPeer(room, email) {
  return room.peerA === email ? room.peerB : room.peerA;
}

function closeRoom(room, reason) {
  if (!room) return;
  clearTimeout(room.graceTimer);
  room.state = 'CLOSED';

  const socketA = peers.get(room.peerA);
  const socketB = peers.get(room.peerB);
  if (socketA) io.to(socketA).emit('peer-disconnected', { reason });
  if (socketB) io.to(socketB).emit('peer-disconnected', { reason });

  rooms.delete(room.id);
  console.log(`[ROOM] Closed: ${room.id} reason=${reason}`);
}

// ─── Admin endpoints ──────────────────────────────────────────────────

// Stats summary
app.get('/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const roomList = Array.from(rooms.values()).map(r => ({
    id: r.id, state: r.state,
    peerA: r.peerA, peerB: r.peerB,
    buffered: r.messageBuffer?.length || 0
  }));
  res.json({
    onlinePeers:      peers.size,
    activeRooms:      Array.from(rooms.values()).filter(r => r.state === 'ACTIVE').length,
    suspendedRooms:   Array.from(rooms.values()).filter(r => r.state === 'SUSPENDED').length,
    rooms:            roomList
  });
});

// Pending registrations
app.get('/admin/pending-users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: db.getPendingUsers() });
});

// All users
app.get('/admin/all-users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: db.getAllUsers() });
});

// Approve user
app.post('/admin/approve-user', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'pending') return res.status(400).json({ error: 'User is not pending' });

    db.setUserStatus(email, 'approved');

    // Notify user via email
    const sentApproval = await sendEmail(
      email,
      'Your Peer Connect registration is approved!',
      `<p>Your account has been approved by the admin.</p><p>You can now <a href="${req.protocol}://${req.get('host')}/login.html">log in</a> and start using Peer Connect.</p>`
    );
    if (!sentApproval) {
      console.warn(`[ADMIN] Approval email to ${email} failed — but user was approved`);
    }

    console.log(`[ADMIN] Approved: ${email}`);
    res.json({ ok: true, message: `${email} approved` });
  } catch (err) {
    console.error('[ADMIN] Approve error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Decline user
app.post('/admin/decline-user', requireAuth, requireAdmin, (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = db.getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'pending') return res.status(400).json({ error: 'User is not pending' });

    db.setUserStatus(email, 'declined');
    console.log(`[ADMIN] Declined: ${email}`);
    res.json({ ok: true, message: `${email} declined` });
  } catch (err) {
    console.error('[ADMIN] Decline error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Active connections (live snapshot)
app.get('/admin/active-connections', requireAuth, requireAdmin, (req, res) => {
  const activeRooms = [];
  for (const [, room] of rooms) {
    if (room.state === 'ACTIVE' || room.state === 'SUSPENDED') {
      const peerAOnline = peers.has(room.peerA);
      const peerBOnline = peers.has(room.peerB);
      activeRooms.push({
        id: room.id,
        peerA: room.peerA,
        peerB: room.peerB,
        peerAOnline,
        peerBOnline,
        state: room.state,
        buffered: room.messageBuffer?.length || 0,
        suspendedPeer: room.suspendedPeer || null
      });
    }
  }
  res.json({
    connections: activeRooms,
    onlinePeers: Array.from(peers.keys())
  });
});

// ─── Socket.io auth middleware ────────────────────────────────────────
// Change the io.use middleware to read from the cookie header instead of auth token:
io.use((socket, next) => {
  const rawCookie = socket.handshake.headers.cookie;
  if (!rawCookie) return next(new Error('Authentication required'));

  const match = rawCookie.match(/peer_session=([^;]+)/);
  const token = match ? match[1] : null;
  if (!token) return next(new Error('Authentication required'));

  const session = db.getSession(token);
  if (!session) return next(new Error('Invalid or expired session'));

  db.refreshSession(token);
  socket.email = session.email;
  next();
});

// ─── Socket.io ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const email = socket.email;
  console.log(`[WS] Connected: ${email}`);

  // Replace any existing socket for this email
  const oldSocketId = peers.get(email);
  if (oldSocketId && oldSocketId !== socket.id) {
    socketToPeer.delete(oldSocketId);
  }

  peers.set(email, socket.id);
  socketToPeer.set(socket.id, email);

  // Confirm identity to client
  socket.emit('registered', { peerId: email, email });

  // Check if this user has a suspended room — restore it
  const room = findRoomForPeer(email);
  if (room && room.state === 'SUSPENDED' && room.suspendedPeer === email) {
    clearTimeout(room.graceTimer);
    room.state = 'ACTIVE';
    room.suspendedPeer = null;

    const other = otherPeer(room, email);
    const otherSocket = peers.get(other);

    // Flush buffered messages
    if (room.messageBuffer?.length > 0) {
      room.messageBuffer.forEach(msg => socket.emit('message', msg));
      room.messageBuffer = [];
    }

    socket.emit('room-restored', { connectedTo: other });
    if (otherSocket) io.to(otherSocket).emit('peer-reconnected', { email });
    console.log(`[ROOM] Restored: ${room.id}`);
  }

  // ── Connection request ─────────────────────────────────────────────
  socket.on('connect-request', ({ targetId }) => {
    const myEmail = email;
    if (!myEmail) return;
    if (targetId === myEmail) return socket.emit('connect-error', { error: 'Cannot connect to yourself' });

    // targetId is now an email
    const targetSocket = peers.get(targetId);
    if (!targetSocket) return socket.emit('connect-error', { error: 'Peer not found or offline' });

    // Check if either peer is already in an active room
    const myRoom     = findRoomForPeer(myEmail);
    const targetRoom = findRoomForPeer(targetId);
    if (myRoom && myRoom.state !== 'CLOSED') return socket.emit('connect-error', { error: 'You are already connected to someone' });
    if (targetRoom && targetRoom.state !== 'CLOSED') return socket.emit('connect-error', { error: 'Peer is already connected to someone' });

    io.to(targetSocket).emit('connection-request', { fromId: myEmail });
    socket.emit('connect-result', { ok: 'pending', message: 'Waiting for peer to accept…' });
    console.log(`[REQ] ${myEmail} → ${targetId}`);
  });

  // ── Accept connection ──────────────────────────────────────────────
  socket.on('connect-accept', ({ targetId }) => {
    const myEmail = email;
    if (!myEmail) return;

    const targetSocket = peers.get(targetId);
    if (!targetSocket) return socket.emit('connect-error', { error: 'Peer went offline' });

    const roomId = getRoomId(myEmail, targetId);
    const room = {
      id: roomId,
      peerA: myEmail,
      peerB: targetId,
      state: 'ACTIVE',
      suspendedPeer: null,
      graceTimer: null,
      messageBuffer: []
    };
    rooms.set(roomId, room);

    // NOTE: we deliberately do NOT emit 'connect-result' back to this socket
    // (the accepter). The accepter already set connectedPeerId/rtcInitiator=false
    // locally the moment they clicked Accept (see 'connection-request' handler
    // in app.js). Emitting it here too used to overwrite rtcInitiator back to
    // true on the accepter's client, making BOTH peers believe they were the
    // initiator — causing both sides to send a WebRTC offer simultaneously
    // (glare), which is what produced the "Called in wrong state: stable" error.
    // Only the original requester — who is genuinely waiting on the result —
    // needs this event.
    io.to(targetSocket).emit('connect-result', { ok: true, peerId: myEmail });
    console.log(`[ROOM] Created: ${roomId}`);
  });

  // ── Decline connection ─────────────────────────────────────────────
  socket.on('connect-decline', ({ targetId }) => {
    const targetSocket = peers.get(targetId);
    if (targetSocket) {
      io.to(targetSocket).emit('connect-result', {
        ok: false,
        error: 'Connection was declined'
      });
    }
  });

  // ── Chat message ───────────────────────────────────────────────────
  socket.on('message', ({ data }) => {
    const myEmail = email;
    const room = findRoomForPeer(myEmail);
    if (!room || room.state === 'CLOSED') return;

    const msg = { from: myEmail, data, timestamp: new Date().toISOString() };
    const other = otherPeer(room, myEmail);
    const otherSocket = peers.get(other);

    if (room.state === 'SUSPENDED') {
      room.messageBuffer.push(msg);
      console.log(`[MSG] Buffered for ${other}`);
    } else if (otherSocket) {
      io.to(otherSocket).emit('message', msg);
    }
  });

  // ── WebRTC signal relay ────────────────────────────────────────────
  socket.on('signal', ({ type, data }) => {
    const myEmail = email;
    const room = findRoomForPeer(myEmail);
    if (!room) return;

    const other = otherPeer(room, myEmail);
    const otherSocket = peers.get(other);
    if (otherSocket) {
      io.to(otherSocket).emit('signal', { type, data, fromId: myEmail });
    }
  });

  // ── Public key exchange ────────────────────────────────────────────
  socket.on('public-key', ({ publicKey }) => {
    const myEmail = email;
    const room = findRoomForPeer(myEmail);
    if (!room) return;

    const other = otherPeer(room, myEmail);
    const otherSocket = peers.get(other);
    if (otherSocket) {
      io.to(otherSocket).emit('peer-public-key', { publicKey, fromId: myEmail });
    }
  });

  // ── Manual disconnect ──────────────────────────────────────────────
  socket.on('disconnect-peer', () => {
    const myEmail = email;
    const room = findRoomForPeer(myEmail);
    if (room) closeRoom(room, 'user-disconnected');
  });

  // ── Socket disconnect ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    peers.delete(email);
    socketToPeer.delete(socket.id);
    console.log(`[WS] Disconnected: ${email}`);

    const room = findRoomForPeer(email);
    if (!room || room.state === 'CLOSED') return;

    // Suspend room — start grace period
    room.state = 'SUSPENDED';
    room.suspendedPeer = email;

    const other = otherPeer(room, email);
    const otherSocket = peers.get(other);
    if (otherSocket) {
      io.to(otherSocket).emit('peer-reconnecting', { email });
    }

    room.graceTimer = setTimeout(() => {
      if (room.state === 'SUSPENDED') {
        console.log(`[ROOM] Grace period expired: ${room.id}`);
        closeRoom(room, 'timeout');
      }
    }, GRACE_PERIOD_MS);

    console.log(`[ROOM] Suspended: ${room.id} — grace period started`);
  });
});

// ─── Serve login.html for root if not authenticated ───────────────────
app.get('/', (req, res) => {
  // If session cookie exists and is valid, serve the app
  const token = req.cookies?.peer_session;
  if (token) {
    const session = db.getSession(token);
    if (session) {
      db.refreshSession(token);
      return res.sendFile(path.join(__dirname, 'public', 'app.html'));
    }
  }
  // Otherwise serve login
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ─── Start (async — db.initDb() loads WASM) ──────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  await db.initDb();
  server.listen(PORT, () => {
    console.log(`Peer Connect hosted server running on port ${PORT}`);
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      console.log(`Admin: ${adminEmail}`);
    } else {
      console.log('No ADMIN_EMAIL set — admin features disabled');
    }
  });
}

start().catch(err => {
  console.error('[FATAL] Failed to start server:', err);
  process.exit(1);
});