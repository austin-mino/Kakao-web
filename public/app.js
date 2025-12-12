const API = '';
let token = localStorage.getItem("token") || null;
let user = localStorage.getItem("user") || null;

// 브라우저별 고유 deviceId 생성
let deviceId = localStorage.getItem("deviceId");
if (!deviceId) {
  deviceId = crypto.randomUUID();
  localStorage.setItem("deviceId", deviceId);
}

const socket = io();
const el = id => document.getElementById(id);

// UI refs
const loginArea = el('loginArea');
const usernameInput = el('username');
const passwordInput = el('password');
const btnLogin = el('btnLogin');
const btnRegister = el('btnRegister');

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

/* ------------------------- 로그인 처리 ------------------------- */
function setAuth(t, u) {
  token = t;
  user = u;
  localStorage.setItem("token", t);
  localStorage.setItem("user", u);

  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');

  loadRooms();
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  token = null;
  user = null;

  loginArea.classList.remove('hidden');
  roomsPanel.classList.add('hidden');
}

/* ------------------------- 서버 요청 ------------------------- */
function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  return fetch("/" + path.replace(/^\//, ''), opts).then(res => res.json());
}

/* ------------------------- 로그인 / 회원가입 ------------------------- */
btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디와 비밀번호를 입력하세요.");

  const res = await request("api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) setAuth(res.token, res.username);
  else alert(res.error || "로그인 실패");
};

btnRegister.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디와 비밀번호를 입력하세요.");

  const res = await request("api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) alert("회원가입 성공! 이제 로그인하세요.");
  else alert(res.error || "회원가입 실패");
};

/* ------------------------- 방 목록 ------------------------- */
async function loadRooms() {
  const res = await request("api/rooms");
  roomsList.innerHTML = "";
  if (!res.ok) return;

  res.rooms.forEach(r => {
    const item = document.createElement("div");
    item.className = "roomItem";
    item.dataset.id = r.id;
    item.dataset.name = r.name;

    item.innerHTML = `
      <div>
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
    `;
    roomsList.appendChild(item);
  });
}

/* ------------------------- 방 클릭 ------------------------- */
let roomOpening = false;
roomsList.addEventListener("click", async e => {
  if (roomOpening) return;
  const item = e.target.closest(".roomItem");
  if (!item) return;

  roomOpening = true;
  openRoom(item.dataset.id, item.dataset.name)
    .finally(() => (roomOpening = false));
});

/* ------------------------- 방 열기 ------------------------- */
async function openRoom(id, name) {
  currentRoom = id;
  roomNameEl.textContent = name;
  chatHeader.classList.remove("hidden");
  compose.classList.remove("hidden");
  messagesEl.innerHTML = "";

  socket.emit("join_room", id);

  const res = await request(`api/rooms/${id}/messages`);
  if (res.ok) {
    renderCache.clear();
    res.messages.forEach(m => renderMessage(m));
    scrollBottom();
  }
}

/* ------------------------- 새 방 생성 ------------------------- */
newRoomBtn.onclick = async () => {
  const name = prompt("새 채팅방 이름을 입력하세요.");
  if (!name || !name.trim()) return;

  const res = await request("api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  if (res.ok) loadRooms();
  else alert(res.error || "방 생성 실패");
};

/* ------------------------- 메시지 렌더링 ------------------------- */
const renderCache = new Set();

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank">${url}</a>`);
}

function renderMessage(m) {
  if (renderCache.has(m.id)) return;
  renderCache.add(m.id);

  const div = document.createElement("div");
  div.className = "msg bubble " + (m.deviceId === deviceId ? "me" : "other");

  let html = "";
  if (m.text) html += `<div class="text">${linkify(escapeHtml(m.text))}</div>`;
  if (m.image) html += `<img src="/api/image/${m.image}" />`;
  html += `<div class="meta">${new Date(m.ts).toLocaleTimeString()} - ${escapeHtml(m.user)}</div>`;

  div.innerHTML = html;
  messagesEl.appendChild(div);
  scrollBottom();
}

/* ------------------------- 메시지 전송 ------------------------- */
async function sendMessage() {
  if (!currentRoom) return alert("방을 선택하세요.");

  const text = textInput.value.trim();
  const image = imageInput.files[0];

  if (!text && !image) return;

  const form = new FormData();
  form.append("text", text);
  if (image) form.append("image", image);
  form.append("deviceId", deviceId);

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method: "POST",
    headers: token ? { "Authorization": "Bearer " + token } : {},
    body: form
  });

  const j = await res.json();
  if (j.ok) {
    textInput.value = "";
    imageInput.value = "";
    scrollBottom();
  }
}

sendBtn.onclick = sendMessage;

// ------------------- Shift+Enter 줄 바꿈 적용 -------------------
textInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    if (e.shiftKey) {
      // Shift + Enter → 줄 바꿈
      const start = textInput.selectionStart;
      const end = textInput.selectionEnd;
      textInput.value = textInput.value.substring(0, start) + "\n" + textInput.value.substring(end);
      textInput.selectionStart = textInput.selectionEnd = start + 1;
      e.preventDefault();
    } else {
      // Enter → 전송
      e.preventDefault();
      if (!e.repeat) sendMessage();
    }
  }
});

/* ------------------------- 실시간 메시지 수신 ------------------------- */
socket.on("new_message", ({ roomId, message }) => {
  if (roomId == currentRoom) renderMessage(message);
});

/* ------------------------- 다크모드 ------------------------- */
darkToggle.onclick = () => document.body.classList.toggle("dark");

/* ------------------------- Helpers ------------------------- */
function escapeHtml(s) {
  return s
    ? s.replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c]))
    : "";
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
