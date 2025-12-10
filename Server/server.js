// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const SECRET = process.env.SECRET_KEY || 'change_this_secret';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(bodyParser.json());
app.use(express.static('public'));

// Simple in-memory store
const devices = {}; // deviceId -> { name, queue: [], lastSeen }

function genId(){ return crypto.randomBytes(6).toString('hex'); }

// Register device (phone)
app.post('/api/register', (req, res) => {
  const { name, secret } = req.body || {};
  if(secret !== SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
  const deviceId = genId();
  devices[deviceId] = { name: name || 'unknown', queue: [], lastSeen: Date.now() };
  return res.json({ ok: true, deviceId });
});

// Send command (from web)
app.post('/api/send', (req, res) => {
  const { apiKey } = req.headers;
  if(apiKey !== SECRET) return res.status(403).json({ ok:false, error:'forbidden' });
  const { deviceId, type, payload } = req.body || {};
  if(!deviceId || !devices[deviceId]) return res.status(400).json({ ok:false, error:'invalid deviceId' });
  const cmd = { id: genId(), type, payload, ts: Date.now() };
  devices[deviceId].queue.push(cmd);
  io.emit('command_queued', { deviceId, cmd });
  return res.json({ ok:true, cmd });
});

// Polling by device
app.get('/api/poll', (req, res) => {
  const deviceId = req.query.deviceId;
  const secret = req.query.secret;
  if(secret !== SECRET) return res.status(403).json({ ok:false, error:'forbidden' });
  if(!deviceId || !devices[deviceId]) return res.status(400).json({ ok:false, error:'invalid deviceId' });
  devices[deviceId].lastSeen = Date.now();
  const cmds = devices[deviceId].queue.slice();
  devices[deviceId].queue = [];
  return res.json({ ok:true, cmds });
});

// Device reports result
app.post('/api/report', (req, res) => {
  const { deviceId, cmdId, status, detail, secret } = req.body || {};
  if(secret !== SECRET) return res.status(403).json({ ok:false, error:'forbidden' });
  io.emit('report', { deviceId, cmdId, status, detail });
  return res.json({ ok:true });
});

// Device list for dashboard
app.get('/api/devices', (req, res) => {
  const list = Object.entries(devices).map(([id,o]) => ({ deviceId:id, name:o.name, lastSeen:o.lastSeen }));
  return res.json({ ok:true, devices:list });
});

io.on('connection', (socket)=>{
  console.log('ws connected');
  socket.on('hello', d=>console.log('hello',d));
});

server.listen(PORT, ()=>console.log('server running on', PORT));
