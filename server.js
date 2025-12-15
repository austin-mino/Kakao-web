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
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

//------------------------------------------------------------
//  Config
//------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_this';

// DB 연결 설정
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

//------------------------------------------------------------
//  Multer
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
//  DB Init
//------------------------------------------------------------
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_at BIGINT
      )
    `);
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
    console.log("✅ Database Tables Ready");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
};
initDB();

//------------------------------------------------------------
//  Express + Socket
//------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/image', express.static(UPLOAD_DIR));

//------------------------------------------------------------
//  Helpers
//------------------------------------------------------------
const signToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
const verifyToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
};

// ★ [중요] 시간을 강제로 숫자로 바꾸는 함수
const fixTime = (obj) => {
  if (obj && obj.ts) {
    obj.ts = parseInt(obj.ts); // 문자를 숫자로 변환
  }
  return obj;
};

//------------------------------------------------------------
//  API Routes
//------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: '정보 부족' });

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) return res.json({ ok: false, error: '이미 존재' });

    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashed]);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ ok: false, error: '아이디 없음' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ ok: false, error: '비번 틀림' });

    const token = signToken({ username: user.username, id: user.id });
    res.json({ ok: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Server Error' });
  }
});

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
    const result = await pool.query(
      'INSERT INTO rooms (name, created_at) VALUES ($1, $2) RETURNING *',
      [name, now]
    );
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.json({ ok: false, error: '생성 실패' });
  }
});

app.delete('/api/rooms/:id', async (req, res) => {
  const roomId = req.params.id;
  try {
    await pool.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    io.emit('room_deleted', { roomId });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.get('/api/rooms/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE room_id = $1 ORDER BY ts ASC',
      [roomId]
    );
    // ★ 여기서 시간 변환 적용
    const messages = result.rows.map(msg => fixTime(msg));
    res.json({ ok: true, messages });
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
    const result = await pool.query(
      `INSERT INTO messages (room_id, "user", text, image, ts, read_by) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [roomId, user, text, image, ts, '[]']
    );

    // ★ 여기서도 시간 변환 적용
    const msg = fixTime(result.rows[0]);
    
    io.to(roomId).emit('new_message', { roomId, message: msg });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

io.on('connection', (socket) => {
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
