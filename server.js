//------------------------------------------------------------
//  Required Modules
//------------------------------------------------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

//------------------------------------------------------------
//  Config
//------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'your_super_secret_key_change_this'; // 보안 키
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 업로드 폴더 없으면 생성
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

//------------------------------------------------------------
//  Multer (이미지 업로드 설정)
//------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    // 파일명 중복 방지를 위해 시간+난수 조합
    cb(null, Date.now() + Math.random().toString(36).substring(2, 8) + ext);
  }
});
const upload = multer({ storage });

//------------------------------------------------------------
//  Database (SQLite)
//------------------------------------------------------------
const DB_FILE = path.join(__dirname, 'chat.db'); // DB 파일명
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  // 사용자 테이블
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);

  // 채팅방 테이블
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    created_at INTEGER
  )`);

  // 메시지 테이블
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    user TEXT,
    text TEXT,
    image TEXT,
    ts INTEGER,
    read_by TEXT
  )`);
});

//------------------------------------------------------------
//  Express + Socket.IO 설정
//------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); // 정적 파일 경로
app.use('/api/image', express.static(UPLOAD_DIR)); // 이미지 접근 경로

//------------------------------------------------------------
//  JWT Helper (토큰 생성/검증)
//------------------------------------------------------------
const signToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });

const verifyToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
};

//------------------------------------------------------------
//  API: 회원가입
//------------------------------------------------------------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: '정보 부족' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
    if (row) return res.json({ ok: false, error: '이미 존재하는 아이디입니다.' });

    // 비밀번호 암호화
    const hashed = await bcrypt.hash(password, 10);
    
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashed], (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true });
    });
  });
});

//------------------------------------------------------------
//  API: 로그인
//------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ ok: false, error: '아이디가 없습니다.' });

    // 암호 비교
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });

    // 토큰 발급
    const token = signToken({ username: user.username, id: user.id });
    res.json({ ok: true, token, username: user.username });
  });
});

//------------------------------------------------------------
//  API: 방 목록 / 생성 / 삭제
//------------------------------------------------------------
app.get('/api/rooms', (req, res) => {
  db.all(`SELECT * FROM rooms ORDER BY id DESC`, [], (err, rows) => {
    res.json({ ok: true, rooms: rows || [] });
  });
});

app.post('/api/rooms', (req, res) => {
  const { name } = req.body;
  if (!name) return;

  const now = Date.now();
  db.run(`INSERT INTO rooms (name, created_at) VALUES (?, ?)`, [name, now], function(err) {
    if (err) return res.json({ ok: false, error: '방 생성 실패' });
    
    db.get(`SELECT * FROM rooms WHERE id = ?`, [this.lastID], (e, row) => {
      res.json({ ok: true, room: row });
    });
  });
});

app.delete('/api/rooms/:id', (req, res) => {
  const roomId = req.params.id;
  // 방 삭제 시 메시지도 함께 삭제
  db.run(`DELETE FROM messages WHERE room_id = ?`, [roomId], () => {
    db.run(`DELETE FROM rooms WHERE id = ?`, [roomId], () => {
      io.emit('room_deleted', { roomId }); // 소켓 알림 (선택사항)
      res.json({ ok: true });
    });
  });
});

//------------------------------------------------------------
//  API: 메시지 목록 / 전송
//------------------------------------------------------------
app.get('/api/rooms/:id/messages', (req, res) => {
  const roomId = req.params.id;
  db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY ts ASC`, [roomId], (err, rows) => {
    res.json({ ok: true, messages: rows || [] });
  });
});

app.post('/api/rooms/:id/messages', upload.single('image'), (req, res) => {
  // 토큰 검증
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const roomId = req.params.id;
  const { text } = req.body;
  const image = req.file ? req.file.filename : null;
  const user = payload.username; // 토큰에서 유저 이름 추출
  const ts = Date.now();

  db.run(
    `INSERT INTO messages (room_id, user, text, image, ts, read_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [roomId, user, text, image, ts, '[]'],
    function(err) {
      if (err) return res.json({ ok: false });

      // 저장된 메시지 다시 가져와서 소켓 전송
      db.get(`SELECT * FROM messages WHERE id = ?`, [this.lastID], (e, msg) => {
        io.to(roomId).emit('new_message', { roomId, message: msg });
        res.json({ ok: true });
      });
    }
  );
});

//------------------------------------------------------------
//  Socket.IO
//------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });
});

//------------------------------------------------------------
//  서버 시작
//------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
