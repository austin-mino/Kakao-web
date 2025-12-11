// Server/server.js
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
const bcrypt = require('bcryptjs');  // ★ 추가됨

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_change_me';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// --- Multer (이미지 업로드) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now().toString() + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({ storage });

// --- DB (SQLite) ---
const DB_FILE = path.join(__dirname, 'messages.db');
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    created_at INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    user TEXT,
    text TEXT,
    image TEXT,
    ts INTEGER,
    read_by TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    last_seen INTEGER,
    queue TEXT
  )`);
});

// --- App + Socket.IO ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// --- Utility ---
const signToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

const verifyToken = (token) => {
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
};

// --- AUTH: 회원가입 ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password)
    return res.status(400).json({ ok:false, error:'아이디/비번 필요' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, row) => {
    if (row) return res.json({ ok:false, error:'이미 존재하는 아이디' });

    const hashed = await bcrypt.hash(password, 10);

    db.run(`INSERT INTO users (username, password) VALUES (?,?)`,
      [username, hashed],
      function(err2){
        if(err2) return res.status(500).json({ ok:false, error:err2.message });
        return res.json({ ok:true });
      });
  });
});

// --- AUTH: 로그인 ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ ok:false, error:'아이디/비번 필요' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user) return res.json({ ok:false, error:'아이디 없음' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ ok:false, error:'비밀번호 틀림' });

    const token = signToken({ user: username, userId: user.id });
    return res.json({ ok:true, token, user: username });
  });
});

// --- AUTH: 자동로그인 ---
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const payload = verifyToken(token);

  if (!payload) return res.json({ ok:false });

  return res.json({
    ok:true,
    user: payload.user
  });
});

// --- API: Rooms ---
app.post('/api/rooms', (req,res) => {
  const { name } = req.body || {};
  if(!name) return res.status(400).json({ ok:false, error:'name required' });

  const now = Date.now();

  db.run(`INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?,?)`,
    [name, now],
    function(err){
      if(err) return res.status(500).json({ ok:false, error:err.message });

      db.get(`SELECT * FROM rooms WHERE name = ?`, [name], (e,row)=>{
        return res.json({ ok:true, room: row });
      });
    });
});

app.get('/api/rooms', (req,res) => {
  db.all(`SELECT * FROM rooms ORDER BY id DESC`, [], (err, rows) => {
    if(err) return res.status(500).json({ ok:false, error:err.message });
    return res.json({ ok:true, rooms: rows });
  });
});

// --- API: Send message ---
app.post('/api/rooms/:roomId/messages', upload.single('image'), (req,res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const payload = verifyToken(token);
  if(!payload) return res.status(401).json({ ok:false, error:'unauthorized' });

  const user = payload.user;
  const roomId = parseInt(req.params.roomId);
  const text = req.body.text || null;
  const imageFile = req.file ? req.file.filename : null;
  const ts = Date.now();

  db.run(
    `INSERT INTO messages (room_id,user,text,image,ts,read_by) VALUES (?,?,?,?,?,?)`,
    [roomId, user, text, imageFile, ts, JSON.stringify([])],
    function(err){
      if(err) return res.status(500).json({ ok:false, error:err.message });

      const messageId = this.lastID;
      db.get(`SELECT * FROM messages WHERE id = ?`, [messageId], (e, msg) => {
        io.emit('new_message', { roomId, message: msg });
        return res.json({ ok:true, message: msg });
      });
    }
  );
});

// --- API: List messages ---
app.get('/api/rooms/:roomId/messages', (req,res) => {
  const roomId = parseInt(req.params.roomId);

  db.all(`SELECT * FROM messages WHERE room_id = ? ORDER BY ts ASC`,
    [roomId],
    (err, rows)=>{
      if(err) return res.status(500).json({ ok:false, error:err.message });
      return res.json({ ok:true, messages: rows });
    });
});

// --- API: mark read ---
app.post('/api/messages/:id/read', (req,res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const payload = verifyToken(token);
  if(!payload) return res.status(401).json({ ok:false, error:'unauthorized' });
  const user = payload.user;
  const id = parseInt(req.params.id);

  db.get(`SELECT read_by FROM messages WHERE id = ?`,
    [id],
    (err,row)=>{
      if(err || !row)
        return res.status(500).json({ ok:false, error: err ? err.message : 'not found' });

      let arr = [];
      try { arr = JSON.parse(row.read_by || '[]'); } catch(e){ arr = []; }

      if(!arr.includes(user)) arr.push(user);

      db.run(`UPDATE messages SET read_by = ? WHERE id = ?`,
        [JSON.stringify(arr), id],
        function(err2){
          if(err2) return res.status(500).json({ ok:false, error:err2.message });
          io.emit('message_read', { messageId:id, user });
          return res.json({ ok:true });
        });
    });
});

// --- image file ---
app.get('/api/image/:filename', (req,res) => {
  const fn = req.params.filename;
  const p = path.join(UPLOAD_DIR, fn);

  if(!fs.existsSync(p))
    return res.status(404).end();

  res.sendFile(p);
});

// --- Devices (Tasker 용) ---
app.post('/api/device/register', (req,res) => {
  const { name, id } = req.body || {};
  if(!id) return res.status(400).json({ ok:false, error:'id required' });

  const now = Date.now();

  db.run(
    `INSERT OR REPLACE INTO devices (id,name,last_seen,queue) VALUES (?,?,?,?)`,
    [id, name || 'phone', now, JSON.stringify([])],
    function(err){
      if(err) return res.status(500).json({ ok:false, error:err.message });

      return res.json({ ok:true });
    }
  );
});

app.get('/api/device/poll', (req,res) => {
  const id = req.query.id;
  if(!id) return res.status(400).json({ ok:false, error:'id required' });

  db.get(`SELECT queue FROM devices WHERE id = ?`, [id], (err,row)=>{
    if(err) return res.status(500).json({ ok:false, error:err.message });
    if(!row) return res.json({ ok:true, cmds: [] });

    let q = [];
    try { q = JSON.parse(row.queue||'[]'); } catch(e) { q = []; }

    db.run(`UPDATE devices SET queue = ?, last_seen = ? WHERE id = ?`,
      [JSON.stringify([]), Date.now(), id]);

    return res.json({ ok:true, cmds: q });
  });
});

// --- Add cmd to device ---
app.post('/api/device/:id/queue', (req,res) => {
  const id = req.params.id;
  const cmd = req.body;

  db.get(`SELECT queue FROM devices WHERE id = ?`,
    [id],
    (err,row)=>{
      if(err || !row) return res.status(404).json({ ok:false, error:'device not found' });

      let q = [];
      try { q = JSON.parse(row.queue||'[]'); } catch(e){ q = []; }

      q.push(cmd);

      db.run(`UPDATE devices SET queue = ? WHERE id = ?`,
        [JSON.stringify(q), id],
        function(err2){
          if(err2) return res.status(500).json({ ok:false, error:err2.message });
          return res.json({ ok:true });
        });
    });
});

// --- Device reporting ---
app.post('/api/device/report', (req,res) => {
  const { type, payload } = req.body || {};

  if(type === 'received') {
    const { roomId, user, text, image } = payload || {};
    const ts = Date.now();

    db.run(
      `INSERT INTO messages (room_id,user,text,image,ts,read_by) VALUES (?,?,?,?,?,?)`,
      [roomId, user||'phone', text||null, image||null, ts, JSON.stringify([])],
      function(err){
        if(err) return res.status(500).json({ ok:false, error:err.message });

        db.get(`SELECT * FROM messages WHERE id = ?`,
          [this.lastID],
          (e,msg)=>{
            io.emit('new_message', { roomId, message: msg });
            return res.json({ ok:true });
          });
      }
    );
  } else {
    return res.json({ ok:true });
  }
});

// --- Socket.IO ---
io.on('connection', (socket) => {

  socket.on('join_room', (roomId) => {
    socket.join('room_' + roomId);
  });

  socket.on('leave_room', (roomId) => {
    socket.leave('room_' + roomId);
  });

  socket.on('enqueue_cmd', ({ deviceId, cmd }) => {
    db.get(`SELECT queue FROM devices WHERE id = ?`,
      [deviceId],
      (err,row)=>{
        if(err || !row) return;

        let q = [];
        try { q = JSON.parse(row.queue||'[]'); } catch(e){ q = []; }
        q.push(cmd);

        db.run(`UPDATE devices SET queue = ? WHERE id = ?`,
          [JSON.stringify(q), deviceId]);
      });
  });
});

server.listen(PORT, () => console.log('Server listening on', PORT));
