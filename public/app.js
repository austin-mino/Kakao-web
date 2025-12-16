const API = '';

/* [핵심 수정 1] 초기 데이터 로드 및 "undefined" 방지 로직 */
let token = localStorage.getItem("token");
let user = localStorage.getItem("user");

// 이전에 잘못 저장된 "undefined" 문자열이 있다면 삭제 처리
if (token === "undefined" || token === "null") token = null;
if (user === "undefined" || user === "null") user = null;

if (!token || !user) {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  token = null;
  user = null;
}

// 브라우저별 고유 ID (화면 배치용)
let deviceId = localStorage.getItem("deviceId");
if (!deviceId) {
  deviceId = crypto.randomUUID();
  localStorage.setItem("deviceId", deviceId);
}

const socket = io();
const el = id => document.getElementById(id);

// UI 요소 가져오기
const loginArea = el('loginArea');
const usernameInput = el('username');
const passwordInput = el('password');
const btnLogin = el('btnLogin');
const btnRegister = el('btnRegister');

// ★ [수정] 모바일 화면 전환을 위해 sidebar와 main 가져오기
const sidebar = el('sidebar'); 
const main = el('main');

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

/* ------------------------- 로그인 상태 처리 (핵심) ------------------------- */
function setAuth(t, u) {
  token = t;
  user = u;
  
  // 정상적인 값일 때만 저장
  if (t && u) {
    localStorage.setItem("token", t);
    localStorage.setItem("user", u);
  }

  // [핵심 수정 2] 아이디 화면에 즉시 반영
  if (myIdDisplay) {
    myIdDisplay.textContent = u;
    if(myIdDisplay.innerText === "") myIdDisplay.innerText = u;
  }

  // 화면 전환 (로그인창 숨김, 방목록 보임)
  if (loginArea) loginArea.classList.add('hidden');
  if (roomsPanel) roomsPanel.classList.remove('hidden');

  loadRooms();
}

// 로그아웃 (초기화)
function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  
  token = null;
  user = null;
  currentRoom = null;

  if (myIdDisplay) myIdDisplay.textContent = "";

  // 화면 전환 (로그인창 보임, 나머지 숨김)
  if (loginArea) loginArea.classList.remove('hidden');
  if (roomsPanel) roomsPanel.classList.add('hidden');
  if (chatHeader) chatHeader.classList.add('hidden');
  if (compose) compose.classList.add('hidden');
  if (messagesEl) messagesEl.innerHTML = "";
  
  if (usernameInput) usernameInput.value = "";
  if (passwordInput) passwordInput.value = "";

  // ★ [수정] 로그아웃 시 모바일 화면 초기화 (목록 보이기)
  if (sidebar) sidebar.classList.remove('hidden');
  if (main) main.classList.add('hidden');
}

// [핵심 수정 3] 페이지 로드 시 상태 결정
if (token && user) {
  // 토큰이 있으면 자동 로그인
  setAuth(token, user);
} else {
  // 없으면 확실하게 로그인 화면 띄우기
  logout();
}

if (btnLogout) btnLogout.onclick = logout;

/* ------------------------- 서버 통신 ------------------------- */
function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  return fetch("/" + path.replace(/^\//, ''), opts).then(res => res.json());
}

/* ------------------------- 로그인 / 회원가입 동작 ------------------------- */
btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (!username || !password) return alert("아이디와 비밀번호를 입력하세요.");

  const res = await request("api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.ok && res.token && res.username) {
    setAuth(res.token, res.username);
  } else {
    alert(res.error || "로그인 실패");
  }
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

/* ------------------------- 방 목록 로드 ------------------------- */
async function loadRooms() {
  const res = await request("api/rooms");
  if (roomsList) roomsList.innerHTML = ""; // 초기화

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
      <div style="flex:1;">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">#${r.id}</div>
      </div>
      <button class="btn-delete" style="background:none; border:none; cursor:pointer; font-size:16px; color:#999;" title="방 삭제">✕</button>
    `;
    roomsList.appendChild(item);
  });
}

/* ------------------------- 방 클릭 이벤트 (입장/삭제) ------------------------- */
let roomOpening = false;
if (roomsList) {
  roomsList.addEventListener("click", async e => {
    // 삭제 버튼 클릭 시
    if (e.target.classList.contains("btn-delete")) {
      e.stopPropagation();
      const item = e.target.closest(".roomItem");
      const roomId = item.dataset.id;
      
      if(!confirm("정말 삭제하시겠습니까?")) return;

      const res = await fetch(`/api/rooms/${roomId}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
      });

      // 여기서는 성공 여부만 확인 (실제 UI 삭제는 socket.on('room_deleted')가 처리해줄 수도 있지만, 
      // 내가 삭제한 건 즉시 반영하는게 UX상 좋음)
      if (res.ok || res.status === 200) {
        // 내가 삭제했을 때도 목록 다시 로드
        loadRooms(); 
        
        // 만약 내가 그 방에 있었다면 나가기
        if (currentRoom == roomId) {
          chatHeader.classList.add("hidden");
          compose.classList.add("hidden");
          messagesEl.innerHTML = "";
          currentRoom = null;
          if (window.innerWidth <= 768) {
             if(sidebar) sidebar.classList.remove('hidden');
             if(main) main.classList.add('hidden');
          }
        }
      } else {
        alert("삭제 실패");
      }
      return;
    }

    // 방 입장 클릭 시
    if (roomOpening) return;
    const item = e.target.closest(".roomItem");
    if (!item) return;

    roomOpening = true;
    openRoom(item.dataset.id, item.dataset.name)
      .finally(() => (roomOpening = false));
  });
}

/* ------------------------- 방 입장 함수 ------------------------- */
async function openRoom(id, name) {
  currentRoom = id;
  roomNameEl.textContent = name;
  chatHeader.classList.remove("hidden");
  compose.classList.remove("hidden");
  messagesEl.innerHTML = "";

  // ★ [수정] 모바일: 방을 누르면 사이드바 숨기고 메인 채팅방 보여주기
  if (window.innerWidth <= 768) {
    if (sidebar) sidebar.classList.add('hidden'); // 목록 숨김
    if (main) main.classList.remove('hidden');    // 채팅방 보임
  }

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

// ★ [수정] 모바일 뒤로가기 기능 (방 제목 누르면 목록으로)
if (roomNameEl) {
  roomNameEl.onclick = () => {
    // 화면 폭이 768px 이하(모바일)일 때만 작동
    if (window.innerWidth <= 768) {
      if (sidebar) sidebar.classList.remove('hidden'); // 목록 보임
      if (main) main.classList.add('hidden');    // 채팅방 숨김
      currentRoom = null; // 방 나가기 처리
    }
  };
}

/* ------------------------- 새 방 만들기 ------------------------- */
if (newRoomBtn) {
  newRoomBtn.onclick = async () => {
    const name = prompt("새 채팅방 이름:");
    if (!name || !name.trim()) return;

    const res = await request("api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });

    if (res.ok) loadRooms();
    else alert(res.error || "실패");
  };
}

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
  // 아이디가 같으면 'me'
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
  
  textInput.value = "";
  imageInput.value = "";
  
  // 미리보기 삭제 (전송 후)
  const preview = document.getElementById('my-img-preview');
  if(preview) preview.remove();

  resizeTextarea();
  textInput.focus();

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method: "POST",
    headers: token ? { "Authorization": "Bearer " + token } : {},
    body: form
  });

  const j = await res.json();
  if (!j.ok && j.error === "Unauthorized") {
    alert("로그인이 필요합니다.");
    logout();
  }
}

if (sendBtn) sendBtn.onclick = sendMessage;

if (textInput) {
  textInput.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  textInput.addEventListener("input", resizeTextarea);
}

function resizeTextarea() {
  if (!textInput) return;
  textInput.style.height = "auto";
  textInput.style.height = (textInput.scrollHeight) + "px";
}

/* ------------------------- 소켓 이벤트 (실시간) ------------------------- */

// 1. 새 메시지 수신
socket.on("new_message", ({ roomId, message }) => {
  if (roomId == currentRoom) {
    renderMessage(message);
    scrollBottom();
  }
});

// 2. [추가됨] 방 삭제 알림 수신 (실시간 동기화)
socket.on('room_deleted', (deletedRoomId) => {
  // 방 목록에서 해당 방 제거
  const roomElement = document.querySelector(`.roomItem[data-id="${deletedRoomId}"]`);
  if (roomElement) {
    roomElement.remove();
  }

  // 만약 내가 보고 있던 방이 삭제되었다면?
  if (currentRoom == deletedRoomId) {
    alert("현재 채팅방이 삭제되었습니다.");
    
    // UI 초기화 (방 나가기)
    chatHeader.classList.add('hidden');
    compose.classList.add('hidden');
    messagesEl.innerHTML = "";
    currentRoom = null;

    // 모바일이면 목록으로 복귀
    if (window.innerWidth <= 768) {
       sidebar.classList.remove('hidden');
       main.classList.add('hidden');
    }
  }
});

if (darkToggle) darkToggle.onclick = () => document.documentElement.classList.toggle("dark");

function escapeHtml(s) {
  return s ? s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c])) : "";
}

function scrollBottom() {
  if (!messagesEl) return;
  setTimeout(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, 0);
}

/* [이미지 미리보기 기능] */
const imgInput = document.getElementById('imageInput');
const composeBox = document.getElementById('compose');

if (imgInput) {
  imgInput.addEventListener('change', function(e) {
    const file = e.target.files[0];
    
    // 기존에 떠있는 미리보기가 있다면 지우기
    const oldPreview = document.getElementById('my-img-preview');
    if (oldPreview) oldPreview.remove();

    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        // 미리보기 박스 만들기
        const div = document.createElement('div');
        div.id = 'my-img-preview';
        div.style.cssText = "padding: 10px; background: #f4f4f4; border-top: 1px solid #ddd; display: flex; align-items: center; justify-content: space-between;";
        
        div.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:12px; color:#666;">첨부됨:</span>
            <img src="${evt.target.result}" style="height:50px; border-radius:4px; border:1px solid #ccc;">
          </div>
          <button onclick="document.getElementById('imageInput').value=''; this.parentNode.remove();" style="border:none; background:none; cursor:pointer; font-size:14px;">✕</button>
        `;

        // 입력창(compose)의 맨 앞에 끼워넣기
        composeBox.insertBefore(div, composeBox.firstChild);
      };
      reader.readAsDataURL(file);
    }
  });
}
