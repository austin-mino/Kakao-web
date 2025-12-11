const API = '';
let token = localStorage.getItem("token") || null;
let user = localStorage.getItem("user") || null;

const socket = io();

const el = id => document.getElementById(id);

// UI refs
const loginArea = el('loginArea');
const nicknameInput = el('nickname');
const btnLogin = el('btnLogin');

const roomsPanel = el('roomsPanel');
const roomsList = el('roomsList');
const newRoomBtn = el('newRoomBtn');

const chatHeader = el('chatHeader');
const roomNameEl = el('roomName');
const darkToggle = el('darkToggle');

const messagesEl = el('messages');
const compose = el('compose');
const textInput = el('textInput');
const imageInput = el('imageInput');
const sendBtn = el('sendBtn');

let currentRoom = null;

/* --------------------------------------------------
      🔐 로그인 처리
----------------------------------------------------- */
function setAuth(t, u) {
  token = t;
  user = u;

  // 저장
  localStorage.setItem("token", t);
  localStorage.setItem("user", u);

  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  token = null;
  user = null;

  loginArea.classList.remove('hidden');
  roomsPanel.classList.add('hidden');
}

function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  return fetch('/' + path.replace(/^\//, ''), opts).then(r => r.json());
}

btnLogin.onclick = async () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) return alert('닉네임 또는 ID를 입력하세요.');

  const res = await request('api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname })
  });

  if (res.ok) {
    setAuth(res.token, res.user);
    loadRooms();
  } else {
    alert(res.error || '로그인 실패');
  }
};

/* --------------------------------------------------
    🔥 자동 로그인
----------------------------------------------------- */
if (token && user) {
  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');
  loadRooms();
}

/* --------------------------------------------------
    🔥 방 목록 불러오기
----------------------------------------------------- */
async function loadRooms() {
  const res = await request('api/rooms');
  roomsList.innerHTML = '';
  if (!res.ok) return;

  res.rooms.forEach(r => {
    const d = document.createElement('div');
    d.className = 'roomItem';
    d.dataset.id = r.id;
    d.dataset.name = r.name;

    d.innerHTML = `
      <div>
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
    `;
    roomsList.appendChild(d);
  });
}

/* --------------------------------------------------
  🔥 모바일 터치 + 클릭 중복 방지
----------------------------------------------------- */
let roomOpening = false;

roomsList.addEventListener("click", (e) => {
  if (roomOpening) return;
  const item = e.target.closest(".roomItem");
  if (!item) return;

  roomOpening = true;
  openRoom(item.dataset.id, item.dataset.name)
    .finally(() => (roomOpening = false));
});

/* --------------------------------------------------
  🔥 방 열기
----------------------------------------------------- */
async function openRoom(id, name) {
  currentRoom = id;
  roomNameEl.textContent = name;

  chatHeader.classList.remove('hidden');
  compose.classList.remove('hidden');
  messagesEl.innerHTML = '';

  socket.emit('join_room', id);

  const res = await request(`api/rooms/${id}/messages`);
  if (res.ok) {
    res.messages.forEach(m => renderMessage(m));
    scrollBottom();
  }
}

/* --------------------------------------------------
  🔥 방 생성
----------------------------------------------------- */
newRoomBtn.onclick = async () => {
  const name = prompt("새 채팅방 이름을 입력하세요.");
  if (!name || !name.trim()) return;

  const res = await request('api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() })
  });

  if (res.ok) {
    loadRooms();
  } else {
    alert(res.error || "방 생성 실패");
  }
};

/* --------------------------------------------------
  🔥 메시지 렌더링 — 중복 방지
----------------------------------------------------- */
const renderCache = new Set(); // 메시지 ID 저장

function renderMessage(m) {
  if (renderCache.has(m.id)) return;
  renderCache.add(m.id);

  const div = document.createElement('div');
  div.className = 'msg bubble ' + (m.user === user ? 'me' : 'other');

  let html = '';
  if (m.text) html += `<div class="text">${escapeHtml(m.text)}</div>`;
  if (m.image) html += `<img src="/api/image/${m.image}" alt="">`;

  html += `<div class="meta">${new Date(m.ts).toLocaleTimeString()}${m.user !== user ? ' - ' + m.user : ''}</div>`;
  div.innerHTML = html;

  div.onclick = async () => {
    await request(`api/messages/${m.id}/read`, { method:'POST' });
  };

  messagesEl.appendChild(div);
}

/* --------------------------------------------------
  🔥 메시지 전송 — 빈 메시지 금지
----------------------------------------------------- */
async function sendMessage() {
  if (!currentRoom) return alert("방을 선택하세요.");

  const rawText = textInput.value;
  const text = rawText.trim();
  const image = imageInput.files[0];

  if (!text && !image) return; // 빈 메시지 금지

  const form = new FormData();
  form.append('text', text);
  if (image) form.append('image', image);

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method: 'POST',
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    body: form
  });

  const j = await res.json();
  if (j.ok) {
    textInput.value = '';
    imageInput.value = '';
    scrollBottom();
  }
}

sendBtn.onclick = sendMessage;

/* --------------------------------------------------
  ✔ Enter 키 — 중복 전송 방지
----------------------------------------------------- */
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.repeat) return;
    sendMessage();
  }
});

/* --------------------------------------------------
  🔥 실시간 메시지 수신
----------------------------------------------------- */
socket.on('new_message', ({ roomId, message }) => {
  if (roomId == currentRoom) {
    renderMessage(message);
    scrollBottom();
  }
});

/* --------------------------------------------------
  🔥 다크 모드
----------------------------------------------------- */
darkToggle.onclick = () => {
  document.body.classList.toggle('dark');
};

/* --------------------------------------------------
  helpers
----------------------------------------------------- */
function escapeHtml(s) {
  return s
    ? s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c]))
    : '';
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
