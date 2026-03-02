// ═══════════════════════════════════════════════════════════════
//  LeboCast 远程控制服务器
//  功能：手机发端通过WebSocket发送指令，控制本机
//  启动：node server.js
//  手机端：打开 http://<电脑IP>:3210
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// 纯Node实现，无需任何npm依赖

const PORT = 3210;
const WS_PORT = 3211;

// ═══════ 投屏码（6位随机，启动时生成） ═══════
const CAST_CODE = String(Math.floor(100000 + Math.random() * 900000));

// ═══════ SSE 客户端列表（供收端实时推送） ═══════
const sseClients = [];
function broadcastSSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((res, i) => {
        try { res.write(msg); } catch (e) { sseClients.splice(i, 1); }
    });
}

// ═══════ MIME 类型 ═══════
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
};

// ═══════ HTTP 文件服务器 + API ═══════
const httpServer = http.createServer((req, res) => {
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ── HTTP API: POST /api/cmd ─────────────────────────────
    if (req.method === 'POST' && req.url === '/api/cmd') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const cmd = JSON.parse(body);
                console.log('  📩 [HTTP] 收到指令:', cmd.type, JSON.stringify(cmd.data || '').substring(0, 60));
                // 推送给收端
                broadcastSSE('command', { type: cmd.type, data: cmd.data, ts: Date.now() });
                handleCommandHTTP(cmd, (result) => {
                    broadcastSSE('result', result);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ── GET /api/info ───────────────────────────────────────
    if (req.url === '/api/info') {
        const os = require('os');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
            cpus: os.cpus().length, memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
            uptime: Math.floor(os.uptime() / 3600) + ' hours', user: os.userInfo().username, node: process.version,
            castCode: CAST_CODE, deviceName: os.hostname(),
            sseClients: sseClients.length,
        }));
        return;
    }

    // ── GET /api/ping（轻量探活） ───────────────────────────
    if (req.url === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, castCode: CAST_CODE, deviceName: os.hostname() }));
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

    // ── 静态文件服务 ────────────────────────────────────────
    let filePath = req.url === '/' ? '/controller.html' : req.url.split('?')[0];
    filePath = path.join(__dirname, filePath);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

// ── HTTP命令处理（同步返回结果） ─────────────────────────────
function handleCommandHTTP(cmd, callback) {
    switch (cmd.type) {
        case 'openUrl':
            exec(`open "${cmd.data}"`, (err) => {
                console.log('  🌐 打开URL:', cmd.data);
                callback({ success: !err, action: 'openUrl', data: cmd.data });
            });
            break;
        case 'openFile':
            exec(`open "${cmd.data}"`, (err) => {
                console.log('  📂 打开文件:', cmd.data);
                callback({ success: !err, action: 'openFile' });
            });
            break;
        case 'notify':
            exec(`osascript -e 'display notification "${(cmd.data && cmd.data.body) || ''}" with title "${(cmd.data && cmd.data.title) || 'LeboCast'}"'`, () => {
                console.log('  💬 发送通知:', cmd.data && cmd.data.title);
                callback({ success: true, action: 'notify' });
            });
            break;
        case 'say':
            exec(`say "${cmd.data}"`, () => {
                console.log('  🔊 语音播报:', cmd.data);
                callback({ success: true, action: 'say' });
            });
            break;
        case 'screenshot':
            exec('screencapture -x /tmp/lebocast_screen.png', () => {
                console.log('  📸 截图完成');
                callback({ success: true, action: 'screenshot', file: '/tmp/lebocast_screen.png' });
            });
            break;
        case 'shell':
            const allowed = ['ls', 'pwd', 'date', 'whoami', 'df', 'uptime', 'cat', 'head', 'tail', 'wc', 'echo'];
            const firstWord = (cmd.data || '').trim().split(/\s+/)[0];
            if (!allowed.includes(firstWord)) {
                console.log('  🚫 拒绝命令:', cmd.data);
                callback({ success: false, action: 'shell', error: '命令不在白名单: ' + firstWord });
                return;
            }
            exec(cmd.data, { timeout: 5000 }, (err, stdout, stderr) => {
                console.log('  🖥  执行命令:', cmd.data);
                callback({ success: !err, action: 'shell', output: stdout || stderr });
            });
            break;
        case 'getInfo':
            const os2 = require('os');
            callback({
                type: 'info', data: {
                    hostname: os2.hostname(), platform: os2.platform(), arch: os2.arch(),
                    cpus: os2.cpus().length, memory: (os2.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
                    user: os2.userInfo().username, node: process.version
                }
            });
            break;
        default:
            callback({ error: '未知指令: ' + cmd.type });
    }
}

httpServer.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIP = net.address;
                break;
            }
        }
    }

    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║  🧠 LeboCast 远程控制服务器已启动       ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║  📱 手机端: http://${localIP}:${PORT}     `);
    console.log(`  ║  🖥  本机端: http://localhost:${PORT}     `);
    console.log(`  ║  🔌 WebSocket: ws://${localIP}:${WS_PORT}  `);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log('  手机和电脑需在同一WiFi下');
    console.log('  在手机浏览器打开上面的地址即可远程控制');
    console.log('');
});

// ═══════ WebSocket 服务器（纯Node实现，不依赖ws库） ═══════
const wsServer = http.createServer();
wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const hash = require('crypto')
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB5FC11CE86')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );

    console.log('  ✅ 客户端已连接');

    socket.on('data', (buf) => {
        const msg = decodeWsFrame(buf);
        if (!msg) return;

        try {
            const cmd = JSON.parse(msg);
            console.log('  📩 收到指令:', cmd.type, cmd.data || '');
            handleCommand(cmd, socket);
        } catch (e) {
            console.log('  ⚠️  解析错误:', msg);
        }
    });

    socket.on('close', () => console.log('  🔌 客户端断开'));
    socket.on('error', () => { });
});

wsServer.listen(WS_PORT, '0.0.0.0');

// ═══════ WebSocket 帧编解码（纯Node） ═══════
function decodeWsFrame(buf) {
    if (buf.length < 2) return null;
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

function sendWs(socket, obj) {
    const str = JSON.stringify(obj);
    const buf = Buffer.from(str, 'utf8');
    const frame = [];
    frame.push(0x81); // text frame
    if (buf.length < 126) frame.push(buf.length);
    else if (buf.length < 65536) { frame.push(126); frame.push((buf.length >> 8) & 0xff, buf.length & 0xff); }
    const header = Buffer.from(frame);
    socket.write(Buffer.concat([header, buf]));
}

// ═══════ 指令处理 ═══════
function handleCommand(cmd, socket) {
    switch (cmd.type) {
        case 'ping':
            sendWs(socket, { type: 'pong', ts: Date.now() });
            break;

        case 'openUrl':
            exec(`open "${cmd.data}"`, (err) => {
                sendWs(socket, { type: 'result', action: 'openUrl', success: !err, data: cmd.data });
                console.log('  🌐 打开URL:', cmd.data);
            });
            break;

        case 'openFile':
            exec(`open "${cmd.data}"`, (err) => {
                sendWs(socket, { type: 'result', action: 'openFile', success: !err });
                console.log('  📂 打开文件:', cmd.data);
            });
            break;

        case 'notify':
            exec(`osascript -e 'display notification "${cmd.data.body || ''}" with title "${cmd.data.title || 'LeboCast'}"'`, () => {
                sendWs(socket, { type: 'result', action: 'notify', success: true });
                console.log('  💬 发送通知:', cmd.data.title);
            });
            break;

        case 'say':
            exec(`say "${cmd.data}"`, () => {
                sendWs(socket, { type: 'result', action: 'say', success: true });
                console.log('  🔊 语音播报:', cmd.data);
            });
            break;

        case 'screenshot':
            const tmpFile = '/tmp/lebocast_screen.png';
            exec(`screencapture -x ${tmpFile}`, () => {
                sendWs(socket, { type: 'result', action: 'screenshot', success: true, file: tmpFile });
                console.log('  📸 截图完成');
            });
            break;

        case 'shell':
            // 安全限制：只允许只读命令
            const allowed = ['ls', 'pwd', 'date', 'whoami', 'df', 'uptime', 'cat', 'head', 'tail', 'wc', 'echo'];
            const firstWord = (cmd.data || '').trim().split(/\s+/)[0];
            if (!allowed.includes(firstWord)) {
                sendWs(socket, { type: 'result', action: 'shell', success: false, error: '命令不在白名单: ' + firstWord });
                console.log('  🚫 拒绝命令:', cmd.data);
                return;
            }
            exec(cmd.data, { timeout: 5000 }, (err, stdout, stderr) => {
                sendWs(socket, { type: 'result', action: 'shell', success: !err, output: stdout || stderr });
                console.log('  🖥  执行命令:', cmd.data);
            });
            break;

        case 'getInfo':
            const os = require('os');
            sendWs(socket, {
                type: 'info',
                data: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    arch: os.arch(),
                    cpus: os.cpus().length,
                    memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
                    uptime: Math.floor(os.uptime() / 3600) + ' hours',
                    user: os.userInfo().username,
                    node: process.version,
                }
            });
            break;

        default:
            sendWs(socket, { type: 'error', msg: '未知指令: ' + cmd.type });
    }
}
