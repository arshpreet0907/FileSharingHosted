# Peer Connect (FileShareHosted) — Codebase Overview

## Summary
Peer Connect is a hosted signaling server for peer-to-peer (P2P) chat and file transfer between browsers. It uses **Socket.io** as a WebSocket-based signaling layer to establish connections and relay messages, while **WebRTC** provides direct browser-to-browser file transfers that bypass the server entirely. All chat messages are end-to-end encrypted using **ECDH key exchange + AES-GCM** derived session keys. The project currently has **no authentication** — anyone who knows a peer's random ID can connect and communicate.

## Current Problem (Driving the Enhancement)
The app is completely open. There is:
- No registration or login
- No admin oversight
- No way to control who connects to whom
- Random hex peer IDs that users must manually share (poor UX and no identity mapping)

The enhancement (described in `enahncement.docx`) proposes adding **email-based authentication**, **OTP email verification**, **admin approval workflow**, and **admin dashboard** for monitoring connections.

## Architecture

### Primary Pattern
**Client-server signaling + P2P data plane.** The server (Node.js/Express) only facilitates connection establishment and relays small chat messages. Large file transfers happen entirely over WebRTC DataChannels between browsers — the server never sees file contents.

### Data Flow Hierarchy
```
Browser A ←→ Socket.io (signaling + chat relay) ←→ Server ←→ Socket.io (signaling + chat relay) ←→ Browser B
Browser A ←→ WebRTC DataChannel (file transfer, direct P2P) ←→ Browser B
```

### Technology Stack
| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥18 |
| Web framework | Express 4 |
| WebSocket | Socket.io 4.7 |
| P2P transport | WebRTC (RTCPeerConnection + DataChannel) |
| E2E encryption | Web Crypto API (ECDH P-256 + AES-GCM 256) |
| Frontend | Vanilla JS + HTML + CSS (no framework) |
| Hosting target | Railway (always-on) |

### How Execution Starts
1. `server.js` starts Express, creates HTTP server, attaches Socket.io
2. Serves static files from `public/`
3. Client-side: `index.html` loads → `App.init()` → loads HTML components (`chat.html`, `fileshare.html`) → connects Socket.io → registers peer ID → ready

## Directory Structure
```
FileShareHosted/
├── server.js                     — Main server: Socket.io signaling, room management, admin stats endpoint
├── package.json                  — Dependencies: express, socket.io, nodemon
├── enahncement.docx              — Enhancement plan document (auth, admin, email verification)
├── HostedServer.zip              — Zipped archive of the project
├── .gitignore
└── public/
    ├── index.html                — Single-page app shell (identity card, tabs)
    ├── assets/
    │   ├── css/
    │   │   └── main.css          — Dark theme UI (JetBrains Mono + Syne fonts, 560px max-width)
    │   └── js/
    │       ├── app.js            — Core app state: socket init, peer ID, E2E encryption, tab switching
    │       ├── chat.js           — Chat UI: send/receive messages, encryption wrapper
    │       └── fileshare.js      — WebRTC file transfer: chunked send/receive, sliding window, history
    └── components/
        ├── chat.html             — Connect card + chat card (message area, input, disconnect button)
        └── fileshare.html        — RTC status, incoming file request, drop zone, progress, history
```

## Key Abstractions

### 1. `server.js` — Signaling Server
- **File**: `server.js` (line 1–end)
- **Responsibility**: Manages peer registration, room lifecycle (create/suspend/close), message relay, WebRTC signaling forwarding
- **Key data structures**:
  - `peers`: `Map<peerId, socketId>` — maps peer IDs to active WebSocket connections
  - `socketToPeer`: `Map<socketId, peerId>` — reverse lookup
  - `rooms`: `Map<roomId, { peerA, peerB, state, suspendedPeer, graceTimer, messageBuffer }>`
- **Room states**: `ACTIVE` → `SUSPENDED` (on network drop, 5 min grace) → `CLOSED` (grace expired or manual disconnect)
- **Key endpoints**: `/admin/stats` — returns online peers, active/suspended rooms, buffered messages

### 2. `App` (app.js) — Core Application State
- **File**: `public/assets/js/app.js`
- **Responsibility**: Singleton that owns the socket connection, peer identity, E2E encryption lifecycle, and coordinates chat/fileshare modules
- **Key state**: `socket`, `myPeerId`, `connectedPeerId`, `rtcInitiator`, `encryptionReady`, `myKeyPair`, `sharedSecret`
- **Lifecycle**: `init()` → `loadComponents()` → `initSocket()` → server assigns peer ID → ready
- **Encryption**: `initEncryption()` generates ECDH key pair, sends public key via socket → peer receives via `peer-public-key` → `deriveSharedSecret()` derives AES-GCM key → `encrypt()`/`decrypt()` wrap all chat messages

### 3. `Chat` (chat.js) — Chat Module
- **File**: `public/assets/js/chat.js`
- **Responsibility**: Send/receive chat messages, manages chat UI (message box, input, system messages)
- **Key behavior**: Messages are encrypted via `App.encrypt()` before sending, decrypted on receipt. `appendSystemMessage()` shows connection/disconnection/reconnection events

### 4. `FileShare` (fileshare.js) — WebRTC File Transfer
- **File**: `public/assets/js/fileshare.js`
- **Responsibility**: Creates RTCPeerConnection with STUN, manages DataChannel, implements chunked file transfer with sliding window ACK
- **Transfer protocol** (JSON control messages + binary chunks):
  1. Sender sends `file-offer` (name, size, totalChunks, ackEvery)
  2. Receiver sends `file-accepted` or `file-declined`
  3. Sender sends chunks with sliding window (windowSize scales by file size: 1 for small, up to 64 for >100MB)
  4. Receiver sends `ack` every `ackEvery` chunks, or `resume-from` on reconnection
  5. Sender sends `file-complete` → receiver assembles Blob → triggers download
- **Chunk sizing**: <1MB = single chunk, <10MB = 64KB chunks, <100MB = 256KB/16 window, >100MB = 256KB/64 window
- **Buffer management**: Pauses if `bufferedAmount` exceeds 8MB

### 5. Room Lifecycle System
- **File**: `server.js` (functions: `closeRoom()`, `findRoomForPeer()`, etc.)
- **States**: `ACTIVE` ↔ `SUSPENDED` (on socket disconnect, 5 min timer) → `CLOSED`
- **Grace period**: 5 minutes. During suspension, incoming messages are buffered. On reconnect, buffer is flushed to the reconnecting peer
- **Consequence**: If a user's browser/tab closes, the other peer sees "Peer reconnecting…" and waits up to 5 minutes

## Data Flow

### Chat Flow (Server-Relayed)
1. User types message → `Chat.sendMessage()` calls `App.encrypt(text)` → AES-GCM encrypts with shared secret
2. `socket.emit('message', { data: base64-encrypted })` sent to server
3. Server's `message` handler finds room, checks state:
   - If `ACTIVE`: forwards to other peer's socket via `io.to(otherSocket).emit('message', msg)`
   - If `SUSPENDED`: buffers message in `room.messageBuffer[]`
4. Receiver's `socket.on('message')` calls `App.decrypt(data)` → displays plaintext

### WebRTC File Transfer Flow (Direct P2P)
1. Sender selects file → `FileShare.sendFile()` reads file to ArrayBuffer, splits into chunks
2. Sends `file-offer` JSON via DataChannel
3. Receiver sees incoming card → clicks Accept → sends `file-accepted`
4. Sender's `pumpChunks()` sends chunks with sliding window control (respects `bufferedAmount`)
5. Receiver's `handleChunk()` stores chunks in `recvChunks[seq]`, sends periodic ACKs
6. On `file-complete`: receiver assembles `Blob` from ordered chunks → triggers browser download

### Connection Establishment Flow
1. User A enters User B's peer ID in connect card → `connect-request` emitted
2. Server checks neither peer is in active room → forwards `connection-request` to B
3. B sees browser `confirm()` dialog → emits `connect-accept` (or `connect-decline`)
4. Server creates room (`peerA`, `peerB`, state: `ACTIVE`) → notifies both via `connect-result`
5. Both sides call `Chat.openChat()` → encryption handshake starts via `initEncryption()`
6. WebRTC connection initializes shortly after (caller is initiator)

## Non-Obvious Behaviors & Design Decisions

### 1. Chat Messages Go Through the Server, Files Do Not
The server relays all chat messages even though E2E encryption is applied. This means the server **can** see encrypted ciphertext but cannot decrypt it. File transfers, however, go directly via WebRTC and the server never touches the bytes. This is a pragmatic design — chat messages are small and benefit from server-side buffering during reconnection; files are large and benefit from direct transfer.

### 2. The 5-Minute Grace Period Is a Double-Edged Sword
If a user's browser crashes or they close the tab, the other peer sees "Peer reconnecting…" for up to 5 minutes before the room closes. This is generous but means a disconnected peer blocks the other user from starting a new connection with anyone else during that time. The `otherSocket` is locked in the room.

### 3. Encryption Is Per-Session, Not Persistent
`initEncryption()` is called fresh every time a connection is established. A new ECDH key pair is generated, the public key is sent via the server socket, and the shared AES-GCM key is derived. There is no persistent key storage — if the page is refreshed, old encrypted messages cannot be read.

### 4. No Authentication Means Anyone Can Impersonate
Currently, peer IDs are random hex strings generated client-side and stored in `localStorage`. There is no server-side validation that a peer ID belongs to a specific user. If someone obtains your peer ID, they can connect to you or impersonate you by setting the same localStorage value.

### 5. WebRTC Is Only Established After Chat Connection
The `fileshare` tab has a `locked` card initially. WebRTC connection is triggered only after a chat connection is established (`ensureRtcConnection` is called after `connect-result`). This ensures the signaling channel exists before attempting P2P setup.

### 6. Sliding Window Scales With File Size Intelligently
The `getTransferParams()` function selects chunk size and window size based on file size:
- Small files: single chunk, no windowing needed
- Medium files (1-10MB): 64KB chunks, window of 4
- Large files (10-100MB): 256KB chunks, window of 16, ACK every 4
- Very large files (>100MB): 256KB chunks, window of 64, ACK every 8
This optimizes for both latency (small files finish instantly) and throughput (large files keep the pipe full).

### 7. Incoming File Requests Survive Tab Switches
`FileShare.acceptFile()` first calls `App.switchTab('files')` to bring the user to the files tab if they're in chat. This is user-friendly but means the UI state must handle cross-tab updates.

### 8. History Is In-Memory Only
Transfer history is stored in the DOM (`#history-list`) and disappears on page refresh. There is no persistent history backend.

### 9. Encryption Badge Starts Invisible
The `enc-badge` element starts as `hidden` (class in the HTML). `App.updateEncryptionBadge()` sets it to either 🔒 E2E Encrypted or 🔓 Not encrypted, but only after the encryption state changes. It starts invisible.

### 10. Server Has No Rate Limiting or Abuse Protection
The `/admin/stats` endpoint is open (no auth). Socket.io events have no rate limiting. A malicious client could spam `connect-request` or `message` events without consequences.

## Module Reference

| File | Purpose |
|------|---------|
| `server.js` | Main server: Socket.io signaling, room lifecycle, peer registration, admin stats endpoint |
| `public/index.html` | SPA shell: identity card, peer ID display, tab navigation |
| `public/assets/js/app.js` | Core state: socket init, peer registration, E2E encryption (ECDH + AES-GCM), tab switching, connect/disconnect logic |
| `public/assets/js/chat.js` | Chat module: send/receive encrypted messages, system messages, chat UI |
| `public/assets/js/fileshare.js` | WebRTC file transfer: PeerConnection setup, DataChannel protocol, chunked send/receive with sliding window, download |
| `public/components/chat.html` | Chat UI partial: connect card, chat card with message area and input |
| `public/components/fileshare.html` | File share UI partial: RTC status, incoming request, drop zone, progress, history |
| `public/assets/css/main.css` | Full dark theme stylesheet (all UI components) |
| `package.json` | Dependencies: express, socket.io, nodemon |

## Enhancement Roadmap (from enahncement.docx)

The enhancement plan has been thoroughly scoped in the docx file. Key architectural changes needed:

1. **Authentication Layer** (new: `db.js`, `auth.js`, `login.html`, `register.html`)
   - SQLite database with `better-sqlite3`
   - Email + password registration with OTP verification via Resend
   - Session tokens with 7-day sliding expiry
   - bcrypt password hashing

2. **Admin Portal** (new: `admin.html`)
   - View pending registration requests (email only)
   - Approve/decline users
   - Monitor active connections, who is connected to whom
   - Admin auto-created from env vars (`ADMIN_EMAIL`, `ADMIN_PASSWORD`)

3. **Peer ID Change** — Replace random hex IDs with email addresses
   - Socket registration uses email instead of generated peer ID
   - Connection requests use email lookup
   - Server maps email ↔ socket ID ↔ room

4. **Deployment** — Railway (no cold starts, ~$0-5/month)
   - No infrastructure changes beyond adding env vars

### Suggested Build Order (from the plan)
1. `db.js` — SQLite schema + queries
2. `auth.js` — register/OTP/login/logout routes
3. `server.js` — add auth middleware, email-based peers
4. `login.html` — login form + link to register
5. `register.html` — email + password + OTP verification
6. `admin.html` — pending users + active users + connections
7. `index.html` — unchanged structure, just uses email now
8. `app.js` — session token for socket auth, email as ID

### New Dependencies
```
better-sqlite3 ^9.0.0
bcrypt ^5.1.0
cookie-parser ^1.4.6
resend ^3.2.0
```

## Deeper Analysis: What Would Change in Each Server Area

### Current `server.js` — What Stays vs What Changes

**Room lifecycle, message relay, signaling forwarding** — these stay largely unchanged. The core P2P connection logic is solid.

**What changes in server.js:**
- `peers` map: keys change from random peer IDs → **email addresses**
- `register` handler: instead of generating/giving peer IDs, it associates the authenticated user's email with their socket
- `connect-request`: looks up by email instead of peer ID
- New endpoint: `/api/auth/*` routes (login, register, verify OTP, logout)
- New middleware: session validation on socket connection
- Admin portal endpoints: `/admin/*` (protected by admin session)
- `/admin/stats` becomes authenticated

### What Changes in `app.js`
- `initSocket()`: after login, pass session token on socket connection
- `connectToPeer()`: accepts email instead of peer ID
- Registration flow: new `register()` function that sends email + password, handles OTP
- Peer ID display: shows email instead of random string

### What Stays the Same
- **`fileshare.js`** — WebRTC is P2P, no server involvement. No changes needed.
- **`chat.js`** — Message format unchanged, encryption unchanged
- **`main.css`** — New login/register/admin pages will need new styles but existing styles stay
- **`components/chat.html`** and **`fileshare.html`** — Unchanged in structure

I've saved this full analysis to `project_info__1.md` in your project root. You now have a complete picture of:
1. What the current codebase does and how it works
2. Every file's responsibility
3. The enhancement plan mapped onto the architecture
4. What changes vs. what stays for each component

The plan in the docx is thorough and well-thought-out. Want me to dive deeper into any specific part — like exactly how the room lifecycle would need to change for email-based peer IDs, or how auth middleware would integrate with Socket.io?