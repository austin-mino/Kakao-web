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

// ★ [핵심] 이미지를 보여주기 위한 경로 설정
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

// Postgres의 BIGINT는 문자열로 반환되므로 숫자로 변환
const fixTime = (obj) => {
  if (obj && obj.ts) {
    obj.ts = parseInt(obj.ts); 
  }
  return obj;
};

//------------------------------------------------------------
//  API Routes
//------------------------------------------------------------

// 1. 회원가입
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

// 2. 로그인
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

// 3. 방 목록 가져오기
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms ORDER BY id DESC');
    res.json({ ok: true, rooms: result.rows });
  } catch (err) {
    res.json({ ok: false, rooms: [] });
  }
});

// 4. 방 만들기 (★ 여기가 수정됨: 실시간 알림 추가)
app.post('/api/rooms', async (req, res) => {
  const { name } = req.body;
  if (!name) return;
  try {
    const now = Date.now();
    const result = await pool.query(
      'INSERT INTO rooms (name, created_at) VALUES ($1, $2) RETURNING *',
      [name, now]
    );
    
    const newRoom = result.rows[0];

    // ★ [추가된 코드] 모든 사람에게 "새 방이 생겼다"고 알림
    io.emit('new_room', newRoom);

    res.json({ ok: true, room: newRoom });
  } catch (err) {
    res.json({ ok: false, error: '생성 실패' });
  }
});

// 5. 방 삭제
app.delete('/api/rooms/:id', async (req, res) => {
  const roomId = req.params.id;
  try {
    await pool.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    
    // 삭제된 방 알림 (객체가 아닌 값만 전송)
    io.emit('room_deleted', roomId);
    
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// 6. 특정 방의 메시지 불러오기
app.get('/api/rooms/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE room_id = $1 ORDER BY ts ASC',
      [roomId]
    );
    const messages = result.rows.map(msg => fixTime(msg));
    res.json({ ok: true, messages });
  } catch (err) {
    res.json({ ok: false, messages: [] });
  }
});

// 7. 메시지 전송 (이미지 포함)
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

    const msg = fixTime(result.rows[0]);
    
    // 안전하게 문자열로 변환하여 전송
    io.to(String(roomId)).emit('new_message', { roomId, message: msg });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

//------------------------------------------------------------
//  Socket Connection
//------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join_room', (roomId) => {
    // 숫자/문자 혼동 방지를 위해 문자열로 통일
    socket.join(String(roomId));
  });
});

// 프론트엔드 라우팅 처리 (새로고침 시 404 방지)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

//------------------------------------------------------------
//  Start Server
//------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

//------------------------------------------------------------
//  [추가 기능] 오래된 데이터 자동 청소 (Auto Cleanup)
//------------------------------------------------------------

// 설정: 0.5일 = 12시간
const RETENTION_DAYS = 0.5; 
const CLEANUP_INTERVAL = 1000 * 60 * 60; // 1시간마다 검사

async function autoCleanup() {
  console.log('🧹 자동 청소 시작: 오래된 데이터 확인 중...');
  
  try {
    // 1. 기준 시간 계산 (현재 시간 - 12시간)
    const cutoffTime = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // 2. 삭제될 메시지 중 '이미지 파일'이 있는지 먼저 조회
    // (DB만 지우고 파일은 남겨두면 "좀비 파일"이 되어 용량을 차지하니까요)
    const oldFilesResult = await pool.query(
      'SELECT image FROM messages WHERE ts < $1 AND image IS NOT NULL', 
      [cutoffTime]
    );

    // 3. 실제 폴더(uploads)에서 파일 삭제
    if (oldFilesResult.rows.length > 0) {
      const fsPromises = require('fs').promises;
      let deletedCount = 0;

      for (const row of oldFilesResult.rows) {
        if (row.image) {
          const filePath = path.join(UPLOAD_DIR, row.image);
          try {
            await fsPromises.unlink(filePath); // 파일 삭제
            deletedCount++;
          } catch (err) {
            // 파일이 이미 없거나 에러나면 그냥 넘어감 (무시)
          }
        }
      }
      console.log(`🗑️ 이미지 파일 ${deletedCount}개 삭제 완료`);
    }

    // 4. DB에서 메시지 삭제
    const dbResult = await pool.query('DELETE FROM messages WHERE ts < $1', [cutoffTime]);
    
    if (dbResult.rowCount > 0) {
      console.log(`✨ DB 메시지 ${dbResult.rowCount}개 삭제 완료 (오래된 데이터)`);
    } else {
      console.log('✨ 삭제할 오래된 데이터가 없습니다.');
    }

  } catch (err) {
    console.error('❌ 자동 청소 중 오류 발생:', err);
  }
}

// 서버가 켜지면 1번 바로 실행하고,
autoCleanup();

// 그 뒤로는 1시간마다 계속 실행 (setInterval)
setInterval(autoCleanup, CLEANUP_INTERVAL);
