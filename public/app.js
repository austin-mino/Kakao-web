// public/app.js
const API = '';
let token = localStorage.getItem('kakao_token') || null;
let user = localStorage.getItem('kakao_user') || null;
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

// helpers
function setAuth(t, u) {
  token = t; user = u;
  localStorage.setItem('kakao_token', t);
  localStorage.setItem('kakao_user', u);
  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');
}

function request(path, opts = {}) {
  opts.headers = opts.headers || {};
  if(token) opts.headers['Authorization'] = 'Bearer ' + token;
  return fetch('/' + path.replace(/^\//,''), opts).then(r=>r.json());
}

// login
btnLogin.onclick = async () => {
  const nickname = nicknameInput.value.trim();
  if(!nickname) return alert('닉네임 입력');
  const res = await request('api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nickname }) });
  if(res.ok){ setAuth(res.token, res.user); loadRooms(); } else alert('login failed');
};

// rooms
newRoomBtn.onclick = async () => {
  const name = prompt('새 채팅방 이름:');
  if(!name) return;
  await request('api/rooms', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
  loadRooms();
};

async function loadRooms(){
  const res = await request('api/rooms');
  roomsList.innerHTML = '';
  if(!res.ok) return;
  res.rooms.forEach(r=>{
    const d = document.createElement('div');
    d.className = 'roomItem';
    d.dataset.id = r.id;       // 🔥 데이터 저장
    d.dataset.name = r.name;   // 🔥 데이터 저장
    d.innerHTML = `
      <div>
        <div class="name">${r.name}</div>
        <div class="meta">#${r.id}</div>
      </div>`;
    roomsList.appendChild(d);
  });
}

/* --------------------------------------------------
    🔥 모바일 터치 + 클릭 모두 지원하는 이벤트 위임
----------------------------------------------------- */
roomsList.addEventListener("click", (e) => {
  const item = e.target.closest(".roomItem");
  if (!item) return;
  openRoom(item.dataset.id, item.dataset.name);
});

roomsList.addEventListener("touchstart", (e) => {
  const item = e.target.closest(".roomItem");
  if (!item) return;
  openRoom(item.dataset.id, item.dataset.name);
});


// open room
async function openRoom(id, name){
  currentRoom = id;
  roomNameEl.textContent = name;
  chatHeader.classList.remove('hidden');
  compose.classList.remove('hidden');
  messagesEl.innerHTML = '';
  // join socket.io room
  socket.emit('join_room', id);
  const res = await request(`api/rooms/${id}/messages`);
  if(res.ok){
    res.messages.forEach(m => renderMessage(m));
    scrollBottom();
  }
}

// render message
function renderMessage(m){
  const div = document.createElement('div');
  div.className = 'msg bubble ' + (m.user === user ? 'me' : 'other');
  let html = `<div class="text">${escapeHtml(m.text||'')}</div>`;
  if(m.image){ html += `<img src="/api/image/${m.image}" alt="img" />`; }
  html += `<div class="meta">${new Date(m.ts).toLocaleTimeString()} ${m.user !== user ? ' - ' + m.user : ''}</div>`;
  div.innerHTML = html;
  div.onclick = async () => {
    await request(`api/messages/${m.id}/read`, { method:'POST' });
  };
  messagesEl.appendChild(div);
}

// send message
sendBtn.onclick = async () => {
  if(!currentRoom) return alert('방 선택');
  const text = textInput.value.trim();
  const form = new FormData();
  form.append('text', text);
  if(imageInput.files && imageInput.files[0]) form.append('image', imageInput.files[0]);

  const res = await fetch(`/api/rooms/${currentRoom}/messages`, {
    method:'POST',
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    body: form
  });
  const j = await res.json();
  if(j.ok){
    renderMessage(j.message);
    textInput.value = '';
    imageInput.value = '';
    scrollBottom();
  } else {
    alert('send failed');
  }
};

// socket handlers
socket.on('new_message', ({ roomId, message }) => {
  if(roomId == currentRoom) renderMessage(message);
  scrollBottom();
  if(document.hidden && Notification.permission === 'granted' && message.user !== user){
    new Notification(message.user, { body: message.text || '이미지', icon: '/favicon.png' });
  }
});

// dark mode
darkToggle.onclick = () => {
  document.body.classList.toggle('dark');
};

// notification
if("Notification" in window && Notification.permission !== 'granted') {
  Notification.requestPermission();
}

function escapeHtml(s){
  if(!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function scrollBottom(){
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* --------------------------------------------------
    🔥 Enter 키로 메시지 전송
----------------------------------------------------- */
textInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

// auto-load
if(token && user){
  loginArea.classList.add('hidden');
  roomsPanel.classList.remove('hidden');
  loadRooms();
}
