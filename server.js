// ═══════════════════════════════════════════════════════════════
//  LeboCast 云端投屏服务器
//  HTTP + WebSocket 同端口，适配云平台部署
//  启动：node server.js
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3210;

// ═══════ 投屏码（6位随机，启动时生成） ═══════
const CAST_CODE = String(Math.floor(100000 + Math.random() * 900000));

// ═══════ 连接管理 ═══════
const sseClients = [];    // 收端 SSE 连接
const wsClients = [];     // WebSocket 连接

function broadcastSSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try { sseClients[i].write(msg); } catch (e) { sseClients.splice(i, 1); }
    }
}

function broadcastWS(obj) {
    const str = JSON.stringify(obj);
    for (let i = wsClients.length - 1; i >= 0; i--) {
        try { sendWsRaw(wsClients[i], str); } catch (e) { wsClients.splice(i, 1); }
    }
}

// ═══════ HTTP 服务器 ═══════
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ── GET /api/info ───────────────────────────────────────
    if (req.url === '/api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
            uptime: Math.floor(os.uptime() / 3600) + ' hours',
            node: process.version,
            castCode: CAST_CODE,
            deviceName: os.hostname(),
            sseClients: sseClients.length,
            wsClients: wsClients.length,
        }));
        return;
    }

    // ── GET /api/ping ───────────────────────────────────────
    if (req.url === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, castCode: CAST_CODE, deviceName: os.hostname() }));
        return;
    }

    // ── POST /api/cmd ───────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/cmd') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const cmd = JSON.parse(body);
                console.log('  📩 [HTTP] 收到指令:', cmd.type, JSON.stringify(cmd.data || '').substring(0, 80));
                // 推送给所有收端
                broadcastSSE('command', { type: cmd.type, data: cmd.data, ts: Date.now() });
                broadcastWS({ type: 'command', action: cmd.type, data: cmd.data, ts: Date.now() });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, action: cmd.type }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── GET /api/stream (SSE) ───────────────────────────────
    if (req.url === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('event: connected\ndata: {}\n\n');
        sseClients.push(res);
        console.log('  📺 收端已连接 (SSE), 当前:', sseClients.length);
        req.on('close', () => {
            const idx = sseClients.indexOf(res);
            if (idx >= 0) sseClients.splice(idx, 1);
            console.log('  📺 收端断开, 剩余:', sseClients.length);
        });
        return;
    }

    // ── 首页 ────────────────────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LANDING_HTML);
        return;
    }

    // ── 健康检查 ────────────────────────────────────────────
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

// ═══════ WebSocket（同端口，HTTP Upgrade） ═══════
server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const hash = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB5FC11CE86')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );

    wsClients.push(socket);
    console.log('  ✅ WebSocket 客户端已连接, 当前:', wsClients.length);

    // 发送欢迎信息
    sendWs(socket, { type: 'welcome', castCode: CAST_CODE, deviceName: os.hostname() });

    socket.on('data', (buf) => {
        const msg = decodeWsFrame(buf);
        if (!msg) return;
        try {
            const cmd = JSON.parse(msg);
            console.log('  📩 [WS] 收到:', cmd.type, JSON.stringify(cmd.data || '').substring(0, 80));
            handleWsCommand(cmd, socket);
        } catch (e) {
            console.log('  ⚠️  解析错误:', msg.substring(0, 100));
        }
    });

    socket.on('close', () => {
        const idx = wsClients.indexOf(socket);
        if (idx >= 0) wsClients.splice(idx, 1);
        console.log('  🔌 WebSocket 断开, 剩余:', wsClients.length);
    });
    socket.on('error', () => {
        const idx = wsClients.indexOf(socket);
        if (idx >= 0) wsClients.splice(idx, 1);
    });
});

// ═══════ WebSocket 指令处理 ═══════
function handleWsCommand(cmd, socket) {
    switch (cmd.type) {
        case 'ping':
            sendWs(socket, { type: 'pong', ts: Date.now() });
            break;
        case 'auth':
            const ok = cmd.code === CAST_CODE;
            sendWs(socket, { type: 'auth_result', success: ok });
            if (ok) console.log('  🔐 认证成功');
            else console.log('  🔐 认证失败, 期望:', CAST_CODE, '收到:', cmd.code);
            break;
        case 'cast':
            // 转发投屏指令给所有收端
            broadcastSSE('command', { type: cmd.action, data: cmd.data, ts: Date.now() });
            sendWs(socket, { type: 'result', action: cmd.action, success: true });
            break;
        case 'getInfo':
            sendWs(socket, {
                type: 'info',
                data: {
                    hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
                    cpus: os.cpus().length, memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
                    node: process.version, castCode: CAST_CODE,
                }
            });
            break;
        default:
            // 通用转发
            broadcastSSE('command', { type: cmd.type, data: cmd.data, ts: Date.now() });
            sendWs(socket, { type: 'result', action: cmd.type, success: true });
    }
}

// ═══════ WebSocket 帧编解码 ═══════
function decodeWsFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) return null; // close frame
    if (opcode === 0x9) return null; // ping
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    let mask = null;
    if (masked) { mask = buf.slice(offset, offset + 4); offset += 4; }
    const data = buf.slice(offset, offset + len);
    if (mask) { for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; }
    return data.toString('utf8');
}

function sendWsRaw(socket, str) {
    const buf = Buffer.from(str, 'utf8');
    const frame = [];
    frame.push(0x81);
    if (buf.length < 126) frame.push(buf.length);
    else if (buf.length < 65536) { frame.push(126, (buf.length >> 8) & 0xff, buf.length & 0xff); }
    socket.write(Buffer.concat([Buffer.from(frame), buf]));
}

function sendWs(socket, obj) {
    sendWsRaw(socket, JSON.stringify(obj));
}

// ═══════ 启动 ═══════
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║  🧠 LeboCast 云端投屏服务器已启动       ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║  🌐 HTTP + WS: http://0.0.0.0:${PORT}`);
    console.log(`  ║  🔑 投屏码: ${CAST_CODE}`);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
});

// ═══════ 落地页 HTML ═══════
const LANDING_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LeboCast 投屏服务</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f23;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:linear-gradient(135deg,#1a1a3e,#2d1b69);border-radius:24px;padding:48px;max-width:420px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.icon{font-size:64px;margin-bottom:16px}
h1{font-size:28px;margin-bottom:8px;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#888;font-size:14px;margin-bottom:32px}
.code-box{background:rgba(255,255,255,.08);border-radius:16px;padding:24px;margin-bottom:24px}
.code-label{font-size:13px;color:#aaa;margin-bottom:8px}
.code{font-size:48px;font-weight:700;letter-spacing:12px;background:linear-gradient(135deg,#667eea,#764ba2);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status{display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:#4ade80}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.info{margin-top:24px;font-size:12px;color:#666;line-height:1.8}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📺</div>
  <h1>LeboCast</h1>
  <p class="sub">AI投屏服务 · 云端运行中</p>
  <div class="code-box">
    <div class="code-label">投屏码</div>
    <div class="code" id="code">------</div>
  </div>
  <div class="status"><span class="dot"></span>服务运行中</div>
  <div class="info">
    在手机APP中输入投屏码即可连接<br>
    支持 WebSocket + SSE 双通道
  </div>
</div>
<script>
fetch('/api/info').then(r=>r.json()).then(d=>{
  document.getElementById('code').textContent=d.castCode||'------';
}).catch(()=>{});
</script>
</body>
</html>`;
