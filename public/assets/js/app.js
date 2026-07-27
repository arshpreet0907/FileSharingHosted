// ── app.js — shared application state and core logic ─────────────────
const App = (() => {
  const API = window.location.origin;

  // ── Shared state ───────────────────────────────────────────────────
  let socket          = null;
  let myPeerId        = null;
  let connectedPeerId = null;
  let rtcInitiator    = false;
  let encryptionReady = false;
  let isAdmin         = false;

  // ── Crypto state ───────────────────────────────────────────────────
  let myKeyPair    = null;
  let sharedSecret = null;

  // ── Tab switching ──────────────────────────────────────────────────
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.getElementById('tab-chat').classList.toggle('hidden', name !== 'chat');
    document.getElementById('tab-files').classList.toggle('hidden', name !== 'files');
    if (name === 'files' && connectedPeerId) {
      FileShare.ensureRtcConnection(rtcInitiator);
    }
  }

  // ── Load HTML components ───────────────────────────────────────────
  async function loadComponents() {
    const [chatHtml, filesHtml] = await Promise.all([
      fetch('/components/chat.html').then(r => r.text()),
      fetch('/components/fileshare.html').then(r => r.text())
    ]);
    document.getElementById('tab-chat').innerHTML  = chatHtml;
    document.getElementById('tab-files').innerHTML = filesHtml;
    FileShare.initDropZone();
  }

  // ── Session check & auth ──────────────────────────────────────────
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        // Not authenticated — redirect to login
        window.location.href = '/login.html';
        return false;
      }
      const data = await res.json();
      myPeerId = data.email;
      isAdmin = data.isAdmin;

      // Show admin link if admin
      const adminLink = document.getElementById('admin-link');
      if (adminLink && isAdmin) adminLink.classList.remove('hidden');

      return true;
    } catch (err) {
      console.error('[APP] Session check failed:', err);
      window.location.href = '/login.html';
      return false;
    }
  }

  // ── Peer ID management ─────────────────────────────────────────────
  function savePeerId(id) {
    // Peer ID is now the email from session — we don't save it locally
  }

  // ── Socket.io ─────────────────────────────────────────────────────
  function initSocket() {
    const sessionToken = getCookie('peer_session');
    if (!sessionToken) {
      window.location.href = '/login.html';
      return;
    }

    socket = io(API, {
      transports: ['websocket'],
      auth: { token: sessionToken }
    });

    socket.on('connect', () => {
      document.getElementById('ws-status').textContent = 'online ●';
    });

    socket.on('disconnect', () => {
      document.getElementById('ws-status').textContent = 'reconnecting…';
      encryptionReady = false;
      showConnectionStatus('warn', 'Reconnecting to server…');
    });

    // Server confirms identity
    socket.on('registered', ({ peerId, email }) => {
      myPeerId = email || peerId;
      document.getElementById('peer-id-text').textContent = myPeerId;
      document.getElementById('connect-card')?.classList.remove('locked');
      console.log(`[APP] Authenticated as ${myPeerId}`);
    });

    // Connection request result
    socket.on('connect-result', ({ ok, peerId, error, message }) => {
      if (ok === true) {
        connectedPeerId = peerId;
        rtcInitiator    = true;
        Chat.openChat(peerId, false);
        initEncryption();
        setTimeout(() => FileShare.ensureRtcConnection(true), 500);
      } else if (ok === 'pending') {
        showAlert('connect-alert', 'info', message || 'Waiting for peer to accept…');
      } else {
        showAlert('connect-alert', 'error', error);
      }
    });

    // Incoming connection request
    socket.on('connection-request', ({ fromId }) => {
      const accepted = confirm(`${fromId} wants to connect.\n\nAccept?`);
      if (accepted) {
        socket.emit('connect-accept', { targetId: fromId });
        connectedPeerId = fromId;
        rtcInitiator    = false;
        Chat.openChat(fromId, true);
        initEncryption();
        setTimeout(() => FileShare.ensureRtcConnection(false), 500);
      } else {
        socket.emit('connect-decline', { targetId: fromId });
      }
    });

    // Incoming encrypted message
    socket.on('message', async ({ from, data, timestamp }) => {
      try {
        const text = encryptionReady ? await decrypt(data) : data;
        Chat.appendMessage('in', text, timestamp);
      } catch (e) {
        Chat.appendMessage('in', '[decryption failed]', timestamp);
      }
    });

    // Peer's public key arrived
    socket.on('peer-public-key', async ({ publicKey }) => {
      await deriveSharedSecret(publicKey);
    });

    // WebRTC signal
    socket.on('signal', (payload) => {
      FileShare.handleSignal(payload);
    });

    // Peer disconnected
    socket.on('peer-disconnected', ({ reason }) => {
      const msg = reason === 'timeout'
        ? 'Peer was offline too long — session ended'
        : 'Peer disconnected';
      Chat.appendSystemMessage(msg);
      showConnectionStatus('error', msg);
      closeConnection();
    });

    // Peer's socket dropped
    socket.on('peer-reconnecting', () => {
      showConnectionStatus('warn', 'Peer reconnecting… (5 min grace period)');
      Chat.appendSystemMessage('Peer lost connection — waiting for them to reconnect…');
      document.getElementById('chat-input')?.setAttribute('disabled', true);
    });

    // Peer came back within grace period
    socket.on('peer-reconnected', () => {
      showConnectionStatus('good', `Connected to ${connectedPeerId}`);
      Chat.appendSystemMessage('Peer reconnected ✓');
      document.getElementById('chat-input')?.removeAttribute('disabled');
      if (!FileShare.isDataChannelOpen()) {
        setTimeout(() => FileShare.ensureRtcConnection(rtcInitiator), 500);
      }
    });

    // My socket reconnected — room restored
    socket.on('room-restored', ({ connectedTo }) => {
      connectedPeerId = connectedTo;
      document.getElementById('ws-status').textContent = 'online ●';
      showConnectionStatus('good', `Reconnected to ${connectedTo}`);
      Chat.appendSystemMessage('Connection restored ✓');
      document.getElementById('chat-input')?.removeAttribute('disabled');
      initEncryption();
      if (!FileShare.isDataChannelOpen()) {
        setTimeout(() => FileShare.ensureRtcConnection(rtcInitiator), 500);
      }
    });

    socket.on('connect-error', ({ error }) => {
      showAlert('connect-alert', 'error', error);
    });
  }

  // ── E2E Encryption ─────────────────────────────────────────────────

  async function initEncryption() {
    encryptionReady = false;
    sharedSecret    = null;

    myKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey']
    );

    const pubKeyJwk = await crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
    socket.emit('public-key', { publicKey: pubKeyJwk });
    console.log('[CRYPTO] Public key sent to peer');
  }

  async function deriveSharedSecret(peerPubKeyJwk) {
    try {
      const peerPublicKey = await crypto.subtle.importKey(
        'jwk',
        peerPubKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      sharedSecret = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerPublicKey },
        myKeyPair.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      encryptionReady = true;
      updateEncryptionBadge(true);
      console.log('[CRYPTO] Shared secret derived — E2E encryption active');
    } catch (e) {
      console.error('[CRYPTO] Key derivation failed:', e);
    }
  }

  async function encrypt(text) {
    if (!encryptionReady || !sharedSecret) return text;
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const encoded   = new TextEncoder().encode(text);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedSecret, encoded);
    const combined  = new Uint8Array(iv.byteLength + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.byteLength);
    return btoa(String.fromCharCode(...combined));
  }

  async function decrypt(base64) {
    if (!encryptionReady || !sharedSecret) return base64;
    const combined  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const iv        = combined.slice(0, 12);
    const data      = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedSecret, data);
    return new TextDecoder().decode(decrypted);
  }

  function updateEncryptionBadge(active) {
    const badge = document.getElementById('enc-badge');
    if (!badge) return;
    badge.textContent = active ? '🔒 E2E Encrypted' : '🔓 Not encrypted';
    badge.style.color = active ? '#1D9E75' : '#EF9F27';
  }

  // ── Connect to peer ───────────────────────────────────────────────
  function connectToPeer() {
    const targetId = document.getElementById('peer-input').value.trim();
    if (!targetId) return;
    if (targetId === myPeerId) return showAlert('connect-alert', 'error', 'Cannot connect to yourself');
    showAlert('connect-alert', 'info', 'Connecting…');
    socket.emit('connect-request', { targetId });
  }

  // ── Disconnect ────────────────────────────────────────────────────
  function disconnectPeer() {
    socket.emit('disconnect-peer');
    Chat.appendSystemMessage('You disconnected');
    FileShare.closeRtc();
    closeConnection();
  }

  function closeConnection() {
    connectedPeerId = null;
    encryptionReady = false;
    sharedSecret    = null;
    document.getElementById('chat-card')?.classList.add('hidden');
    document.getElementById('connect-card')?.classList.remove('locked');
    document.getElementById('peer-input').value = '';
    hideAlert('connect-alert');
    updateEncryptionBadge(false);
    FileShare.closeRtc();
  }

  // ── Logout ────────────────────────────────────────────────────────
  async function handleLogout() {
    // If connected, confirm
    if (connectedPeerId) {
      if (!confirm('You are connected to a peer. Disconnect and log out?')) return;
      socket.emit('disconnect-peer');
    }

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // Continue even if request fails
    }
    window.location.href = '/login.html';
  }

  // ── Connection status bar ─────────────────────────────────────────
  function showConnectionStatus(type, msg) {
    const bar = document.getElementById('connection-status');
    if (!bar) return;
    const dotClass = { good: 'dot-green', warn: 'dot-amber', error: 'dot-red', info: 'dot-blue' }[type] || 'dot-blue';
    bar.className = `status-bar ${type}`;
    bar.innerHTML = `<span class="status-dot ${dotClass}"></span><span>${msg}</span>`;
    bar.classList.remove('hidden');
  }

  // ── Copy peer ID ──────────────────────────────────────────────────
  function copyId() {
    if (!myPeerId) return;
    navigator.clipboard.writeText(myPeerId).catch(() => {});
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  }

  // ── Alert helpers ─────────────────────────────────────────────────
  function showAlert(id, type, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideAlert(id) {
    document.getElementById(id)?.classList.add('hidden');
  }

  // ── Getters ───────────────────────────────────────────────────────
  function getSocket()            { return socket; }
  function getMyPeerId()          { return myPeerId; }
  function getConnectedPeerId()   { return connectedPeerId; }
  function getAPI()               { return API; }
  function isEncryptionReady()    { return encryptionReady; }

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    const authed = await checkSession();
    if (!authed) return;
    await loadComponents();
    initSocket();
  }

  return {
    init, switchTab, connectToPeer, disconnectPeer, handleLogout,
    copyId, showAlert, hideAlert, showConnectionStatus,
    encrypt, decrypt,
    getSocket, getMyPeerId, getConnectedPeerId, getAPI, isEncryptionReady
  };
})();
