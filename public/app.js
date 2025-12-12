const API = '';
let token = localStorage.getItem("token") || null;
let user = localStorage.getItem("user") || null;

const socket = io();
const el = id => document.getElementById(id);

// UI 요소
const loginArea = el('loginArea');
const usernameInput = el('username');
const passwordInput = el('password');
const btnLogin = el('btnLogin');
const btnRegister = el('btnRegister');

const roomsPanel = el('roomsPanel');
const roomsList = el('roomsList');
const newRoomBtn = el('newRoomBtn');
const btnLogout = el('btnLogout');
const myIdDisplay = el('myIdDisplay');

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

  if(myIdDisplay) myIdDisplay.textContent = u; 

  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');

  loadRooms();
}

if (token && user) {
  setAuth(token, user);
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  token = null;
  user = null;
  currentRoom = null;

  if(myIdDisplay) myIdDisplay.textContent = "";

  loginArea.classList.remove('hidden');
  roomsPanel.classList.add('hidden');
  chatHeader.classList.add('hidden');
  compose.classList.add('hidden');
  messagesEl.innerHTML = "";
  
  usernameInput.value = "";
  passwordInput.value = "";
}

if (btnLogout) btnLogout.onclick = logout;

/* ------------------------- 서버 통신 ------------------------- */
function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  return fetch("/" + path.replace(/^\//, ''), opts).then(res => res.json());
}

/* ------------------------- 로그인 / 회원가입 ------------------------- */
btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("입력해주세요.");

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
  if (!username || !password) return alert("입력해주세요.");

  const res = await request("api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) alert("가입 성공");
  else alert(res.error || "가입 실패");
};

/* ------------------------- 방 목록 (삭제 버튼 추가) ------------------------- */
async function loadRooms() {
  const res = await request("api/rooms");
  roomsList.innerHTML = "";
  if (!res.ok) {
    if (res.error === 'Unauthorized') logout();
    return;
  }

  res.rooms.forEach(r => {
    const item = document.createElement("div");
    item.className = "roomItem";
    item.dataset.id = r.id;
    item.dataset.name = r.name;

    // [수정] 방 이름 옆에 삭제 버튼(X) 추가
    item.innerHTML = `
      <div style="flex:1;">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
      <button class="btn-delete" style="background:none; border:none; cursor:pointer; font-size:16px; color:#999;">✕</button>
    `;
    roomsList.appendChild(item);
  });
}

/* ------------------------- 방 클릭 및 삭제 처리 ------------------------- */
let roomOpening = false;
roomsList.addEventListener("click", async e => {
  // 1. 삭제 버튼 클릭 시
  if (e.target.classList.contains("btn-delete")) {
    e.stopPropagation(); // 방 입장 이벤트 막기
    
    const item = e.target.closest(".roomItem");
    const roomId = item.dataset.id;
    
    if(!confirm("정말 이 방을 삭제하시겠습니까?")) return;

    // 삭제 API 요청 (서버에 DELETE 메소드가 구현되어 있어야 함)
    const res = await fetch(`/api/rooms/${roomId}`, {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + token }
    });

    if (res.ok || res.status === 200) {
      loadRooms(); // 목록 갱신
      if (currentRoom == roomId) {
        // 현재 보고 있는 방이면 닫기
        chatHeader.classList.add("hidden");
        compose.classList.add("hidden");
        messagesEl.innerHTML = "";
        currentRoom = null;
      }
    } else {
      alert("방 삭제 실패 (권한이 없거나 서버 오류)");
    }
    return;
  }

  // 2. 방 입장 클릭 시
  if (roomOpening) return;
  const item = e.target.closest(".roomItem");
  if (!item) return;

  roomOpening = true;
  openRoom(item.dataset.id, item.dataset.name)
    .finally(() => (roomOpening = false));
});

/* ------------------------- 방 기능들 ------------------------- */
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
  } else {
    if(res.error === "Unauthorized") logout();
  }
}

newRoomBtn.onclick = async () => {
  const name = prompt("방 이름:");
  if (!name || !name.trim()) return;

  const res = await request("api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  if (res.ok) loadRooms();
  else alert(res.error || "실패");
};

/* ------------------------- 메시지 처리 ------------------------- */
const renderCache = new Set();

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank">${url}</a>`);
}

function renderMessage(m) {
  if (renderCache.has(m.id)) return;
  renderCache.add(m.id);

  const div = document.createElement("div");
  // [유지] 아이디 기준 정렬
  const isMe = (m.user === user); 
  div.className = "msg bubble " + (isMe ? "me" : "other");

  let html = "";
  if (m.text) html += `<div>${linkify(escapeHtml(m.text))}</div>`;
  if (m.image) html += `<img src="/api/image/${m.image}" />`;
  html += `<div class="meta">${new Date(m.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${escapeHtml(m.user)}</div>`;

  div.innerHTML = html;
  messagesEl.appendChild(div);
  scrollBottom();
}

async function sendMessage() {
  if (!currentRoom) return alert("방 선택 필요");

  const text = textInput.value;
  const image = imageInput.files[0];

  if (!text.trim() && !image) return;

  const form = new FormData();
  form.append("text", text);
  if (image) form.append("image", image);
  
  textInput.value = "";
  imageInput.value = "";
  resizeTextarea();
  textInput.focus();

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method: "POST",
    headers: token ? { "Authorization": "Bearer " + token } : {},
    body: form
  });
  
  const j = await res.json();
  if (!j.ok && j.error === "Unauthorized") logout();
}

sendBtn.onclick = sendMessage;

textInput.addEventListener("keydown", e => {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function resizeTextarea() {
  textInput.style.height = "auto";
  textInput.style.height = (textInput.scrollHeight) + "px";
}
textInput.addEventListener("input", resizeTextarea);

socket.on("new_message", ({ roomId, message }) => {
  if (roomId == currentRoom) {
    renderMessage(message);
    scrollBottom();
  }
});

darkToggle.onclick = () => document.body.classList.toggle("dark");

function escapeHtml(s) {
  return s ? s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c])) : "";
}

function scrollBottom() {
  setTimeout(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 0);
}
