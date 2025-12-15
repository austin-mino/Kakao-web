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
const { Pool } = require('pg'); // ★ sqlite3 대신 pg 사용
const bcrypt = require('bcryptjs');
require('dotenv').config(); // 로컬 테스트용 (Render에서는 환경변수 설정으로 대체)

//------------------------------------------------------------
//  Config
//------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_this';

// ★ Supabase 연결 설정
// Render 환경변수에 DATABASE_URL을 넣어야 합니다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Supabase 연결 시 필수 옵션
  },
});

const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 업로드 폴더 없으면 생성 (주의: Render 무료버전은 재배포 시 이 폴더가 초기화됨)
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

//------------------------------------------------------------
//  Multer (이미지 업로드 설정)
//------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + Math.random().toString(36).substring(2, 8) + ext);
  }
});
const upload = multer({ storage });

//------------------------------------------------------------
//  Database Initialization (PostgreSQL)
//------------------------------------------------------------
const initDB = async () => {
  try {
    // 사용자 테이블
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      )
    `);

    // 채팅방 테이블
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_at BIGINT
      )
    `);

    // 메시지 테이블
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        "user" TEXT,
        text TEXT,
        image TEXT,
        ts BIGINT,
        read_by TEXT
      )
    `);
    console.log("✅ Database Tables Created/Verified");
  } catch (err) {
    console.error("❌ Database Init Error:", err);
  }
};

initDB();

//------------------------------------------------------------
//  Express + Socket.IO 설정
//------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

// 정적 파일 연결
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/image', express.static(UPLOAD_DIR));

//------------------------------------------------------------
//  JWT Helper
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
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: '정보 부족' });

  try {
    // 중복 체크
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) {
      return res.json({ ok: false, error: '이미 존재하는 아이디입니다.' });
    }

    // 암호화 및 저장
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashed]);
    
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

//------------------------------------------------------------
//  API: 로그인
//------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ ok: false, error: '아이디가 없습니다.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });

    const token = signToken({ username: user.username, id: user.id });
    res.json({ ok: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server Error' });
  }
});

//------------------------------------------------------------
//  API: 방 목록 / 생성 / 삭제
//------------------------------------------------------------
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY id DESC');
    res.json({ ok: true, rooms: result.rows });
  } catch (err) {
    res.json({ ok: false, rooms: [] });
  }
});

app.post('/api/rooms', async (req, res) => {
  const { name } = req.body;
  if (!name) return;

  try {
    const now = Date.now();
    // RETURNING * 을 사용해 생성된 데이터를 바로 받아옴 (Postgres 특징)
    const result = await pool.query(
      'INSERT INTO rooms (name, created_at) VALUES ($1, $2) RETURNING *',
      [name, now]
    );
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.json({ ok: false, error: '방 생성 실패 (중복된 이름 등)' });
  }
});

app.delete('/api/rooms/:id', async (req, res) => {
  const roomId = req.params.id;
  try {
    // ON DELETE CASCADE 설정이 테이블에 없다면 메시지 먼저 삭제 필요하지만,
    // 안전하게 트랜잭션 없이 순차 삭제 진행
    await pool.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    
    io.emit('room_deleted', { roomId });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: '삭제 실패' });
  }
});

//------------------------------------------------------------
//  API: 메시지 목록 / 전송
//------------------------------------------------------------
app.get('/api/rooms/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE room_id = $1 ORDER BY ts ASC',
      [roomId]
    );
    res.json({ ok: true, messages: result.rows });
  } catch (err) {
    res.json({ ok: false, messages: [] });
  }
});

app.post('/api/rooms/:id/messages', upload.single('image'), async (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const roomId = req.params.id;
  const { text } = req.body;
  const image = req.file ? req.file.filename : null;
  const user = payload.username;
  const ts = Date.now();

  try {
    // "user"는 Postgres 예약어일 수 있으므로 따옴표 처리
    const result = await pool.query(
      `INSERT INTO messages (room_id, "user", text, image, ts, read_by) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [roomId, user, text, image, ts, '[]']
    );

    const msg = result.rows[0];
    io.to(roomId).emit('new_message', { roomId, message: msg });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

//------------------------------------------------------------
//  Socket.IO
//------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });
});

// SPA 라우팅 지원 (맨 아래)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

//------------------------------------------------------------
//  서버 시작
//------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
