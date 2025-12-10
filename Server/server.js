// server.js
const express = require("express");
const app = express();
const cors = require("cors");
const bodyParser = require("body-parser");

app.use(cors());
app.use(bodyParser.json());

// 환경설정
const PORT = process.env.PORT || 3000;

// 메모리 임시 DB (나중에 MongoDB/SQLite로 변경 가능)
let messageQueue = []; // 웹 → 폰으로 갈 메시지
let receivedMessages = []; // 폰에서 서버로 보낸 메시지

// -----------------------------
// 1) 웹이 메시지를 서버로 보내는 API
// -----------------------------
app.post("/api/send", (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: "text is required" });
    }

    // Tasker가 읽을 큐에 추가
    messageQueue.push({
        text,
        timestamp: Date.now()
    });

    console.log("웹 → 서버로 메시지 도착:", text);

    res.json({ success: true });
});

// -----------------------------
// 2) Tasker(폰)가 서버에서 메시지를 가져가는 API
// -----------------------------
app.get("/api/poll", (req, res) => {
    if (messageQueue.length === 0)
        return res.json({ text: null });

    const msg = messageQueue.shift(); // 한 개 꺼내기

    console.log("폰으로 전달되는 메시지:", msg.text);

    res.json(msg);
});

// -----------------------------
// 3) Tasker(폰)가 서버로 받은 카톡을 업로드하는 API
// -----------------------------
app.post("/api/receive", (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: "text is required" });
    }

    receivedMessages.push({
        text,
        timestamp: Date.now(),
    });

    console.log("폰 → 서버로 받은 메시지:", text);

    res.json({ success: true });
});

// -----------------------------
// 4) 웹이 받은 메시지를 가져가는 API (웹 UI에 표시)
// -----------------------------
app.get("/api/messages", (req, res) => {
    res.json(receivedMessages);
});

// -----------------------------
app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
