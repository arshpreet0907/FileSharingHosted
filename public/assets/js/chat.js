// ── chat.js — chat tab logic ──────────────────────────────────────────
const Chat = (() => {

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text  = input.value.trim();
    const to    = App.getConnectedPeerId();
    if (!text || !to) return;

    // Encrypt before sending
    const data = await App.encrypt(text);
    App.getSocket().emit('message', { data });

    // Show plaintext locally
    appendMessage('out', text, new Date().toISOString());
    input.value = '';
  }

  function openChat(peerId, incoming) {
    const chatCard    = document.getElementById('chat-card');
    const connectCard = document.getElementById('connect-card');
    if (!chatCard) return;

    document.getElementById('chat-peer-id').textContent = peerId;
    chatCard.classList.remove('hidden');
    connectCard?.classList.add('locked');
    document.getElementById('chat-messages').innerHTML = '';

    appendSystemMessage(incoming
      ? `${peerId} connected to you`
      : `Connected to ${peerId}`
    );
    App.showConnectionStatus('good', `Connected to ${peerId}`);
    document.getElementById('chat-input')?.focus();
  }

  function appendMessage(dir, text, timestamp) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = `msg msg-${dir}`;
    const t = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<div>${escHtml(text)}</div><div class="msg-time">${t}</div>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function appendSystemMessage(text) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'msg msg-system';
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { sendMessage, openChat, appendMessage, appendSystemMessage };
})();
