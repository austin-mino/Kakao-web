const API = '';
let token = localStorage.getItem("token") || null;
let user = localStorage.getItem("user") || null;

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

/* --------------------------------------------------
      🔐 로그인 처리
----------------------------------------------------- */
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

/* 서버 요청 도우미 */
function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  return fetch("/" + path.replace(/^\//, ''), opts).then(res => res.json());
}

/* --------------------------------------------------
   🔑 로그인 버튼
----------------------------------------------------- */
btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디와 비밀번호를 입력하세요.");

  const res = await request("api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) {
    // 서버에서 user 대신 username을 보낸 경우
    setAuth(res.token, res.user || res.username);
  } else {
    alert(res.error || "로그인 실패");
  }
};

/* --------------------------------------------------
   🆕 회원가입 버튼
----------------------------------------------------- */
btnRegister.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디와 비밀번호를 입력하세요.");

  const res = await request("api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) {
    alert("회원가입 성공! 이제 로그인하세요.");
  } else {
    alert(res.error || "회원가입 실패");
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
   🔥 방 목록 불러오기 + 삭제 버튼
----------------------------------------------------- */
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
      <div class="roomInfo">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
      <button class="deleteRoomBtn">삭제</button>
    `;

    // 삭제 버튼 클릭
    item.querySelector(".deleteRoomBtn").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`방 "${r.name}"을 삭제하시겠습니까?`)) return;

      const delRes = await request(`api/rooms/${r.id}`, { method: "DELETE" });
      if (delRes.ok) item.remove();
      else alert(delRes.error || "방 삭제 실패");
    });

    roomsList.appendChild(item);
  });
}

/* --------------------------------------------------
  🔥 방 클릭
----------------------------------------------------- */
let roomOpening = false;
roomsList.addEventListener("click", async (e) => {
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

/* --------------------------------------------------
  🔥 방 생성
----------------------------------------------------- */
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

/* --------------------------------------------------
  🔥 메시지 렌더링 (카톡풍, 색상 구분)
----------------------------------------------------- */
const renderCache = new Set();

function renderMessage(m) {
  if (renderCache.has(m.id)) return;
  renderCache.add(m.id);

  const div = document.createElement("div");
  div.className = "msg bubble " + (m.user === user ? "me" : "other");

  let html = "";
  if (m.text) html += `<div class="text">${escapeHtml(m.text)}</div>`;
  if (m.image) html += `<img src="/api/image/${m.image}" />`;

  html += `<div class="meta">${new Date(m.ts).toLocaleTimeString()}</div>`;
  div.innerHTML = html;

  messagesEl.appendChild(div);
  scrollBottom();
}

/* --------------------------------------------------
  🔥 메시지 전송
----------------------------------------------------- */
async function sendMessage() {
  if (!currentRoom) return alert("방을 선택하세요.");

  const text = textInput.value.trim();
  const image = imageInput.files[0];

  if (!text && !image) return;

  const form = new FormData();
  form.append("text", text);
  if (image) form.append("image", image);

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method: "POST",
    headers: token ? { "Authorization": "Bearer " + token } : {},
    body: form
  });

  const j = await res.json();
  if (j.ok) {
    textInput.value = "";
    imageInput.value = "";
  }
}

sendBtn.onclick = sendMessage;
textInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) sendMessage(); }
});

/* --------------------------------------------------
  🔥 실시간 메시지 수신
----------------------------------------------------- */
socket.on("new_message", ({ roomId, message }) => {
  if (roomId == currentRoom) renderMessage(message);
});

/* --------------------------------------------------
  🔥 다크모드
----------------------------------------------------- */
darkToggle.onclick = () => document.body.classList.toggle("dark");

/* --------------------------------------------------
  Helpers
----------------------------------------------------- */
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
