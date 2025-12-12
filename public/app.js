const API = '';
// 저장된 토큰 가져오기 (자동 로그인)
let token = localStorage.getItem("token") || null;
let user = localStorage.getItem("user") || null;

const socket = io();
const el = id => document.getElementById(id);

// UI 요소 가져오기
const loginArea = el('loginArea');
const usernameInput = el('username');
const passwordInput = el('password');
const btnLogin = el('btnLogin');
const btnRegister = el('btnRegister');

const roomsPanel = el('roomsPanel');
const roomsList = el('roomsList');
const newRoomBtn = el('newRoomBtn');
const btnLogout = el('btnLogout');
const myIdDisplay = el('myIdDisplay'); // 아이디 표시할 곳

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
  
  // 로그인 정보 저장
  localStorage.setItem("token", t);
  localStorage.setItem("user", u);

  // [중요] 화면에 내 아이디 표시
  if(myIdDisplay) myIdDisplay.textContent = u; 

  // 화면 전환
  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');

  loadRooms();
}

// 페이지 열 때 자동 로그인 확인
if (token && user) {
  setAuth(token, user);
}

// 로그아웃
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

/* ------------------------- 서버 통신 함수 ------------------------- */
function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  return fetch("/" + path.replace(/^\//, ''), opts).then(res => res.json());
}

/* ------------------------- 로그인 / 회원가입 버튼 ------------------------- */
btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디/비번을 입력하세요.");

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
  if (!username || !password) return alert("아이디/비번을 입력하세요.");

  const res = await request("api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) alert("가입 성공! 로그인하세요.");
  else alert(res.error || "가입 실패");
};

/* ------------------------- 방 목록 ------------------------- */
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

    item.innerHTML = `
      <div>
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
    `;
    roomsList.appendChild(item);
  });
}

// 방 클릭 이벤트
let roomOpening = false;
roomsList.addEventListener("click", async e => {
  if (roomOpening) return;
  const item = e.target.closest(".roomItem");
  if (!item) return;

  roomOpening = true;
  openRoom(item.dataset.id, item.dataset.name)
    .finally(() => (roomOpening = false));
});

/* ------------------------- 방 입장 ------------------------- */
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

/* ------------------------- 새 방 만들기 ------------------------- */
newRoomBtn.onclick = async () => {
  const name = prompt("방 이름을 입력하세요.");
  if (!name || !name.trim()) return;

  const res = await request("api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });

  if (res.ok) loadRooms();
  else alert(res.error || "생성 실패");
};

/* ------------------------- 메시지 그리기 (핵심 수정) ------------------------- */
const renderCache = new Set();

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank">${url}</a>`);
}

function renderMessage(m) {
  if (renderCache.has(m.id)) return;
  renderCache.add(m.id);

  const div = document.createElement("div");
  
  // [핵심] 메시지를 보낸 사람(m.user)과 현재 로그인한 사람(user)이 같으면 'me' (오른쪽)
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

/* ------------------------- 메시지 전송 ------------------------- */
async function sendMessage() {
  if (!currentRoom) return alert("방을 선택하세요.");

  const text = textInput.value;
  const image = imageInput.files[0];

  if (!text.trim() && !image) return;

  const form = new FormData();
  form.append("text", text);
  if (image) form.append("image", image);
  
  // UI 초기화
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
  if (!j.ok) {
    if(j.error === "Unauthorized") {
      alert("로그인이 필요합니다.");
      logout();
    } else {
      alert("전송 실패");
    }
  }
}

sendBtn.onclick = sendMessage;

/* ------------------------- 엔터키 처리 ------------------------- */
textInput.addEventListener("keydown", e => {
  if (e.isComposing) return; // 한글 조합 중 중복 전송 방지

  if (e.key === "Enter") {
    if (!e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
});

/* ------------------------- 입력창 높이 조절 ------------------------- */
function resizeTextarea() {
  textInput.style.height = "auto";
  textInput.style.height = (textInput.scrollHeight) + "px";
}
textInput.addEventListener("input", resizeTextarea);

/* ------------------------- 소켓 수신 ------------------------- */
socket.on("new_message", ({ roomId, message }) => {
  if (roomId == currentRoom) {
    renderMessage(message);
    scrollBottom();
  }
});

/* ------------------------- 다크모드/기타 ------------------------- */
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
