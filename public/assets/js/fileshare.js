// ── fileshare.js — WebRTC DataChannel + file transfer logic ──────────
const FileShare = (() => {
  const KB = 1024;
  const MB = 1024 * 1024;
  const MAX_BUFFER = 8 * MB;

  function getTransferParams(fileSize) {
    if (fileSize < MB)        return { chunkSize: Math.max(fileSize, 1), windowSize: 1,  ackEvery: 1 };
    if (fileSize < 10 * MB)   return { chunkSize: 64 * KB,              windowSize: 4,  ackEvery: 1 };
    if (fileSize < 100 * MB)  return { chunkSize: 256 * KB,             windowSize: 16, ackEvery: 4 };
    return                           { chunkSize: 256 * KB,             windowSize: 64, ackEvery: 8 };
  }

  // ── WebRTC state ──────────────────────────────────────────────────
  let pc          = null;
  let dataChannel = null;
  let isInitiator = false;

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // ── Send state ────────────────────────────────────────────────────
  let sendFileObj   = null;
  let sendChunks    = [];
  let sendSeq       = 0;
  let sendAcked     = -1;
  let sendTotal     = 0;
  let sendStartTime = 0;
  let sendParams    = null;

  // ── Receive state ─────────────────────────────────────────────────
  let recvMeta     = null;
  let recvChunks   = {};
  let recvLastAck  = -1;
  let recvAckEvery = 1;

  // ── Ensure RTC connection ─────────────────────────────────────────
  function ensureRtcConnection(initiator = true) {
    if (pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting')) return;
    isInitiator = initiator;
    createPeerConnection(initiator);
  }

  function isDataChannelOpen() {
    return dataChannel?.readyState === 'open';
  }

  // ── Create RTCPeerConnection ──────────────────────────────────────
  async function createPeerConnection(initiator) {
    if (pc) { pc.close(); pc = null; }
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = ({ candidate }) => {
      const targetId = App.getConnectedPeerId();
      if (!targetId) return;
      App.getSocket().emit('signal', { type: 'ice', data: candidate });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[RTC] connectionState: ${s}`);
      switch (s) {
        case 'connected':
          setRtcStatus('connected', `P2P connected to ${App.getConnectedPeerId()?.slice(0,14)}…`);
          document.getElementById('send-card')?.classList.remove('locked');
          break;
        case 'disconnected':
          setRtcStatus('connecting', 'P2P connection lost — waiting…');
          document.getElementById('send-card')?.classList.add('locked');
          break;
        case 'failed':
          setRtcStatus('failed', 'P2P connection failed — reconnect peer to retry');
          document.getElementById('send-card')?.classList.add('locked');
          break;
        case 'closed':
          setRtcStatus('', 'P2P connection closed');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => console.log(`[RTC] ice: ${pc.iceConnectionState}`);
    pc.onsignalingstatechange     = () => console.log(`[RTC] signaling: ${pc.signalingState}`);

    if (initiator) {
      dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
      setupDataChannel(dataChannel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      App.getSocket().emit('signal', { type: 'offer', data: offer });
      setRtcStatus('connecting', 'Establishing P2P connection…');
    } else {
      pc.ondatachannel = ({ channel }) => {
        dataChannel = channel;
        setupDataChannel(dataChannel);
      };
    }
  }

  // ── Handle incoming WebRTC signal ─────────────────────────────────
  async function handleSignal({ type, data, fromId }) {
    console.log(`[SIGNAL] ${type} from ${fromId}`);
    if (type === 'offer') {
      if (!pc || pc.signalingState === 'closed') await createPeerConnection(false);
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      App.getSocket().emit('signal', { type: 'answer', data: answer });
      setRtcStatus('connecting', 'Answering P2P request…');
    } else if (type === 'answer') {
      await pc?.setRemoteDescription(new RTCSessionDescription(data));
    } else if (type === 'ice' && data) {
      await pc?.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
    }
  }

  // ── DataChannel setup ─────────────────────────────────────────────
  function setupDataChannel(ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen  = () => {
      console.log('[DC] open');
      setRtcStatus('connected', `P2P connected to ${App.getConnectedPeerId()?.slice(0,14)}…`);
      document.getElementById('send-card')?.classList.remove('locked');
    };
    ch.onclose   = () => console.log('[DC] closed');
    ch.onmessage = ({ data }) => {
      if (typeof data === 'string') handleControl(JSON.parse(data));
      else handleChunk(data);
    };
  }

  // ── Control messages ──────────────────────────────────────────────
  function handleControl(msg) {
    switch (msg.type) {
      case 'file-offer':
        recvMeta     = { name: msg.name, size: msg.size, totalChunks: msg.totalChunks };
        recvChunks   = {};
        recvLastAck  = -1;
        recvAckEvery = msg.ackEvery || 1;
        showIncomingRequest(msg.name, msg.size, msg.totalChunks);
        break;
      case 'file-accepted':
        startSending();
        break;
      case 'file-declined':
        setTransferStatus('paused', '✕ Declined by peer');
        break;
      case 'ack':
        sendAcked = msg.seq;
        pumpChunks();
        break;
      case 'resume-from':
        sendSeq   = msg.seq + 1;
        sendAcked = msg.seq;
        setTransferStatus('sending', `↺ Resuming from chunk ${sendSeq}…`);
        pumpChunks();
        break;
      case 'file-complete':
        assembleAndDownload();
        break;
    }
  }

  // ── File selection ────────────────────────────────────────────────
  function fileSelected(input) {
    if (!input.files[0]) return;
    sendFileObj = input.files[0];
    const label = document.getElementById('file-selected-label');
    label.textContent = `${sendFileObj.name} (${fmtSize(sendFileObj.size)})`;
    label.classList.remove('hidden');
    const btn = document.getElementById('send-file-btn');
    btn.disabled    = false;
    btn.textContent = `Send ${sendFileObj.name}`;
  }

  function initDropZone() {
    const dz = document.getElementById('drop-zone');
    if (!dz) return;
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      sendFileObj = file;
      const label = document.getElementById('file-selected-label');
      label.textContent = `${file.name} (${fmtSize(file.size)})`;
      label.classList.remove('hidden');
      const btn = document.getElementById('send-file-btn');
      btn.disabled    = false;
      btn.textContent = `Send ${file.name}`;
    });
  }

  // ── Send ──────────────────────────────────────────────────────────
  async function sendFile() {
    if (!sendFileObj || !dataChannel || dataChannel.readyState !== 'open') return;
    sendParams = getTransferParams(sendFileObj.size);
    const buffer = await sendFileObj.arrayBuffer();
    sendChunks = [];
    let offset = 0;
    while (offset < buffer.byteLength) {
      sendChunks.push(buffer.slice(offset, offset + sendParams.chunkSize));
      offset += sendParams.chunkSize;
    }
    sendTotal     = sendChunks.length;
    sendSeq       = 0;
    sendAcked     = -1;
    sendStartTime = Date.now();
    sendParams.done = false;

    showProgress(sendFileObj.name);
    document.getElementById('send-file-btn').disabled = true;

    dataChannel.send(JSON.stringify({
      type: 'file-offer',
      name: sendFileObj.name,
      size: sendFileObj.size,
      totalChunks: sendTotal,
      ackEvery: sendParams.ackEvery
    }));
    setTransferStatus('sending', 'Waiting for peer to accept…');
  }

  function startSending() {
    setTransferStatus('sending', 'Sending…');
    sendAcked = -1;
    pumpChunks();
  }

  // ── Sliding window pump ───────────────────────────────────────────
  function pumpChunks() {
    if (dataChannel?.readyState !== 'open') return;

    while (sendSeq < sendTotal && sendSeq - sendAcked <= sendParams.windowSize) {
      if (dataChannel.bufferedAmount > MAX_BUFFER) {
        dataChannel.bufferedAmountLowThreshold = MAX_BUFFER / 2;
        dataChannel.onbufferedamountlow = () => {
          dataChannel.onbufferedamountlow = null;
          pumpChunks();
        };
        break;
      }
      dataChannel.send(sendChunks[sendSeq]);
      sendSeq++;
    }

    const pct     = Math.round((Math.max(sendAcked + 1, 0) / sendTotal) * 100);
    const elapsed = (Date.now() - sendStartTime) / 1000;
    const bytes   = (sendAcked + 1) * sendParams.chunkSize;
    const speed   = elapsed > 0 ? fmtSize(bytes / elapsed) + '/s' : '—';
    updateProgress(pct);
    document.getElementById('transfer-speed').textContent = speed;

    if (sendSeq >= sendTotal && sendAcked >= sendTotal - 1 && !sendParams.done) {
      sendParams.done = true;
      dataChannel.send(JSON.stringify({ type: 'file-complete' }));
      setTransferStatus('done', `✓ Sent ${sendFileObj.name}`);
      updateProgress(100);
      addHistory(sendFileObj.name, sendFileObj.size, 'sent');
    }
  }

  // ── Receive ───────────────────────────────────────────────────────
  function showIncomingRequest(name, size, totalChunks) {
    document.getElementById('incoming-filename').textContent = name;
    document.getElementById('incoming-meta').textContent =
      `${fmtSize(size)} · ${totalChunks} chunks`;
    document.getElementById('incoming-card')?.classList.remove('hidden');
    App.switchTab('files');
  }

  function acceptFile() {
    document.getElementById('incoming-card')?.classList.add('hidden');
    showProgress(recvMeta.name);
    setTransferStatus('receiving', 'Receiving…');
    const keys = Object.keys(recvChunks).map(Number);
    if (keys.length > 0) {
      const last = Math.max(...keys);
      recvLastAck = last;
      dataChannel.send(JSON.stringify({ type: 'resume-from', seq: last }));
      setTransferStatus('receiving', `↺ Resuming from chunk ${last + 1}…`);
    } else {
      dataChannel.send(JSON.stringify({ type: 'file-accepted' }));
    }
  }

  function declineFile() {
    document.getElementById('incoming-card')?.classList.add('hidden');
    dataChannel?.send(JSON.stringify({ type: 'file-declined' }));
    recvMeta = null; recvChunks = {};
  }

  function handleChunk(data) {
    if (!recvMeta) return;
    recvChunks[recvLastAck + 1] = data;
    recvLastAck++;
    if (recvLastAck % recvAckEvery === recvAckEvery - 1 || recvLastAck === recvMeta.totalChunks - 1) {
      dataChannel.send(JSON.stringify({ type: 'ack', seq: recvLastAck }));
    }
    if (recvLastAck % recvAckEvery === recvAckEvery - 1 || recvLastAck === recvMeta.totalChunks - 1) {
      const pct = Math.round((recvLastAck + 1) / recvMeta.totalChunks * 100);
      updateProgress(pct);
      setTransferStatus('receiving', `Receiving… ${recvLastAck + 1}/${recvMeta.totalChunks}`);
    }
  }

  function assembleAndDownload() {
    if (!recvMeta) return;
    const ordered = Array.from({ length: recvMeta.totalChunks }, (_, i) => recvChunks[i]).filter(Boolean);
    const blob    = new Blob(ordered);
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href = url; a.download = recvMeta.name; a.click();
    URL.revokeObjectURL(url);
    addHistory(recvMeta.name, recvMeta.size, 'received');
    setTransferStatus('done', `✓ Downloaded ${recvMeta.name}`);
    recvMeta = null; recvChunks = {}; recvLastAck = -1;
  }

  // ── Close RTC ─────────────────────────────────────────────────────
  function closeRtc() {
    dataChannel?.close();
    pc?.close();
    dataChannel = null;
    pc          = null;
    setRtcStatus('', 'No P2P connection');
    document.getElementById('send-card')?.classList.add('locked');
  }

  // ── UI helpers ────────────────────────────────────────────────────
  function setRtcStatus(state, text) {
    const dot = document.getElementById('rtc-dot');
    if (!dot) return;
    dot.className = 'rtc-dot' + (state ? ' ' + state : '');
    document.getElementById('rtc-status-text').textContent = text;
  }

  function showProgress(filename) {
    document.getElementById('transfer-filename').textContent = filename;
    document.getElementById('progress-fill').style.width    = '0%';
    document.getElementById('transfer-pct').textContent     = '0%';
    document.getElementById('transfer-speed').textContent   = '—';
    document.getElementById('progress-card')?.classList.remove('hidden');
  }

  function updateProgress(pct) {
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('transfer-pct').textContent  = pct + '%';
  }

  function setTransferStatus(type, text) {
    const el = document.getElementById('transfer-status');
    if (!el) return;
    el.className   = 'transfer-status' + (type ? ' status-' + type : '');
    el.textContent = text;
  }

  function addHistory(name, size, direction) {
    const card = document.getElementById('history-card');
    const list = document.getElementById('history-list');
    if (!card || !list) return;
    card.classList.remove('hidden');
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-name" title="${name}">${name}</span>
      <span class="history-size">${fmtSize(size)}</span>
      <span class="pill pill-${direction === 'sent' ? 'sent' : 'received'}">${direction}</span>`;
    list.prepend(item);
  }

  function fmtSize(bytes) {
    if (bytes < 1024)      return bytes + ' B';
    if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }

  return {
    ensureRtcConnection, handleSignal, isDataChannelOpen,
    fileSelected, initDropZone, sendFile,
    acceptFile, declineFile, closeRtc
  };
})();
