#!/usr/bin/env node
/*!
 * cast-server.js — AI投屏 中继服务器 v1.0.0
 * 零 npm 依赖，纯 Node.js 原生模块
 *
 * 启动方式:
 *   node cast-server.js
 *   node cast-server.js --port 3210 --static ./public
 *
 * 或作为模块引入:
 *   const { CastServer } = require('./cast-server');
 *   const srv = new CastServer({ port: 3210, staticDir: __dirname });
 *   srv.on('command', (cmd, reply) => {
 *       // 自定义指令处理
 *       reply({ success: true, custom: true });
 *   });
 *   srv.start();
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const crypto = require('crypto');
const url = require('url');

// ──────────────────────────────────────────────
// 简易 EventEmitter
// ──────────────────────────────────────────────
class EventEmitter {
    constructor() { this._listeners = {}; }
    on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); return this; }
    off(event, fn) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = fn ? this._listeners[event].filter(f => f !== fn) : [];
        return this;
    }
    emit(event, ...args) { (this._listeners[event] || []).forEach(fn => fn(...args)); }
}

// ──────────────────────────────────────────────
// MIME 类型
// ──────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
};

// ──────────────────────────────────────────────
// CastServer 类
// ──────────────────────────────────────────────
class CastServer extends EventEmitter {
    /**
     * @param {Object}  opts
     * @param {number}  [opts.port=3210]          HTTP 监听端口
     * @param {number}  [opts.wsPort=3211]         WebSocket 端口
     * @param {string}  [opts.staticDir]           静态文件目录（默认当前目录）
     * @param {string}  [opts.defaultPage]         默认页（默认 controller.html）
     * @param {string[]}[opts.allowedCommands]     shell 指令白名单（null 表示关闭 shell）
     * @param {string}  [opts.appName='AI投屏']    应用名（日志 + 通知）
     */
    constructor(opts = {}) {
        super();
        this.port = opts.port || 3210;
        this.wsPort = opts.wsPort || 3211;
        this.staticDir = opts.staticDir || __dirname;
        this.defaultPage = opts.defaultPage || 'controller.html';
        this.appName = opts.appName || 'AI投屏';
        this.allowedCommands = opts.allowedCommands !== undefined
            ? opts.allowedCommands
            : ['ls', 'pwd', 'date', 'whoami', 'df', 'uptime', 'cat', 'head', 'tail', 'wc', 'echo'];

        this._sseClients = [];
        this._httpServer = null;
        this._wsServer = null;
        this._localIP = this._detectIP();
    }

    // ── 广播给所有 SSE 收端 ──────────────────────────
    broadcast(event, data) {
        const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        this._sseClients = this._sseClients.filter(res => {
            try { res.write(msg); return true; } catch (e) { return false; }
        });
    }

    // ── 启动服务器 ────────────────────────────────────
    start() {
        this._startHTTP();
        this._startWS();
        return this;
    }

    stop() {
        if (this._httpServer) this._httpServer.close();
        if (this._wsServer) this._wsServer.close();
    }

    // ── HTTP 服务 ─────────────────────────────────────
    _startHTTP() {
        this._httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

            const reqUrl = url.parse(req.url).pathname;

            // POST /api/cmd — 接收指令
            if (req.method === 'POST' && reqUrl === '/api/cmd') {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', () => {
                    try {
                        const cmd = JSON.parse(body);
                        this._log(`📩 [HTTP] ${cmd.type}`, cmd.data);
                        this.broadcast('command', { type: cmd.type, data: cmd.data, ts: Date.now() });
                        // 先让自定义处理器尝试处理
                        let handled = false;
                        if (this._listeners['command'] && this._listeners['command'].length) {
                            handled = true;
                            this.emit('command', cmd, (result) => {
                                this.broadcast('result', result);
                                this._json(res, result);
                            });
                        }
                        if (!handled) {
                            this._executeCommand(cmd, (result) => {
                                this.broadcast('result', result);
                                this._json(res, result);
                            });
                        }
                    } catch (e) {
                        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    }
                });
                return;
            }

            // GET /api/info — 设备信息
            if (reqUrl === '/api/info') {
                this._json(res, this._sysInfo());
                return;
            }

            // GET /api/stream — SSE推送通道
            if (reqUrl === '/api/stream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                res.write('event: connected\ndata: {}\n\n');
                this._sseClients.push(res);
                this._log(`📺 收端连接 SSE [共 ${this._sseClients.length} 个]`);
                req.on('close', () => {
                    this._sseClients = this._sseClients.filter(r => r !== res);
                    this._log(`📺 收端断开 [剩 ${this._sseClients.length} 个]`);
                });
                return;
            }

            // 静态文件
            let filePath = reqUrl === '/' ? this.defaultPage : reqUrl.split('?')[0];
            filePath = path.join(this.staticDir, filePath);
            const ext = path.extname(filePath);
            const mime = MIME[ext] || 'application/octet-stream';
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not Found'); return; }
                res.writeHead(200, { 'Content-Type': mime });
                res.end(data);
            });
        });

        this._httpServer.listen(this.port, '0.0.0.0', () => {
            this._printBanner();
            this.emit('start', { port: this.port, ip: this._localIP });
        });
    }

    // ── WebSocket 服务 ────────────────────────────────
    _startWS() {
        this._wsServer = http.createServer();
        this._wsServer.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            const hash = crypto.createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-5AB5FC11CE86')
                .digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
            );
            this._log('✅ WebSocket 客户端连接');
            socket.on('data', buf => {
                const msg = this._decodeWS(buf);
                if (!msg) return;
                try {
                    const cmd = JSON.parse(msg);
                    this._log(`📩 [WS] ${cmd.type}`, cmd.data);
                    this.broadcast('command', { type: cmd.type, data: cmd.data, ts: Date.now() });
                    if (cmd.type === 'ping') { this._sendWS(socket, { type: 'pong', ts: Date.now() }); return; }
                    this._executeCommand(cmd, result => {
                        this.broadcast('result', result);
                        this._sendWS(socket, result);
                    });
                } catch (e) { }
            });
            socket.on('close', () => this._log('🔌 WebSocket 客户端断开'));
            socket.on('error', () => { });
        });
        this._wsServer.listen(this.wsPort, '0.0.0.0');
        this._wsServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`  ⚠️  WebSocket 端口 ${this.wsPort} 已被占用，跳过 WS（HTTP+SSE 仍正常）`);
            } else {
                console.error('  WS 错误:', err.message);
            }
        });
    }

    // ── 内置指令处理 ──────────────────────────────────
    _executeCommand(cmd, cb) {
        switch (cmd.type) {
            case 'openUrl':
                exec(`open "${cmd.data}"`, err => cb({ success: !err, action: 'openUrl', data: cmd.data }));
                break;
            case 'openFile':
                exec(`open "${cmd.data}"`, err => cb({ success: !err, action: 'openFile' }));
                break;
            case 'notify': {
                const t = (cmd.data && cmd.data.title) || this.appName;
                const b = (cmd.data && cmd.data.body) || '';
                exec(`osascript -e 'display notification "${b}" with title "${t}"'`,
                    () => cb({ success: true, action: 'notify' }));
                break;
            }
            case 'say':
                exec(`say "${cmd.data}"`, () => cb({ success: true, action: 'say' }));
                break;
            case 'screenshot': {
                const f = '/tmp/cast_screen.png';
                exec(`screencapture -x ${f}`, () => cb({ success: true, action: 'screenshot', file: f }));
                break;
            }
            case 'shell': {
                const allowed = this.allowedCommands;
                if (!allowed) { cb({ success: false, action: 'shell', error: 'shell 已禁用' }); return; }
                const first = (cmd.data || '').trim().split(/\s+/)[0];
                if (!allowed.includes(first)) {
                    cb({ success: false, action: 'shell', error: '非白名单命令: ' + first }); return;
                }
                exec(cmd.data, { timeout: 5000 }, (err, stdout, stderr) =>
                    cb({ success: !err, action: 'shell', output: stdout || stderr }));
                break;
            }
            case 'getInfo':
                cb({ success: true, action: 'getInfo', data: this._sysInfo() });
                break;
            default:
                // 转发给自定义处理
                this.emit('unknownCommand', cmd, cb);
                if (!this._listeners['unknownCommand'] || !this._listeners['unknownCommand'].length) {
                    cb({ success: false, error: '未知指令: ' + cmd.type });
                }
        }
    }

    // ── 工具方法 ──────────────────────────────────────
    _json(res, data) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    _sysInfo() {
        return {
            hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
            cpus: os.cpus().length,
            memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
            user: os.userInfo().username, node: process.version,
            ip: this._localIP, port: this.port,
        };
    }

    _detectIP() {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) return net.address;
            }
        }
        return 'localhost';
    }

    _log(msg, data) {
        const d = data !== undefined ? ' ' + JSON.stringify(data).substring(0, 60) : '';
        console.log(`  ${msg}${d}`);
    }

    _printBanner() {
        const ip = this._localIP;
        console.log('');
        console.log('  ╔════════════════════════════════════════════╗');
        console.log(`  ║  🚀 ${this.appName} 中继服务器已启动              ║`);
        console.log('  ╠════════════════════════════════════════════╣');
        console.log(`  ║  📱 发端(手机): http://${ip}:${this.port}`);
        console.log(`  ║  💻 收端(电脑): http://localhost:${this.port}`);
        console.log(`  ║  🔌 WebSocket:  ws://${ip}:${this.wsPort}`);
        console.log('  ╚════════════════════════════════════════════╝');
        console.log('');
    }

    // WebSocket 帧解码
    _decodeWS(buf) {
        if (buf.length < 2) return null;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f, offset = 2;
        if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        let mask = null;
        if (masked) { mask = buf.slice(offset, offset + 4); offset += 4; }
        const data = buf.slice(offset, offset + len);
        if (mask) { for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; }
        return data.toString('utf8');
    }

    // WebSocket 帧编码
    _sendWS(socket, obj) {
        const str = JSON.stringify(obj);
        const buf = Buffer.from(str, 'utf8');
        const frame = [0x81];
        if (buf.length < 126) frame.push(buf.length);
        else if (buf.length < 65536) { frame.push(126, (buf.length >> 8) & 0xff, buf.length & 0xff); }
        socket.write(Buffer.concat([Buffer.from(frame), buf]));
    }
}

// ──────────────────────────────────────────────
// 命令行直接运行
// ──────────────────────────────────────────────
if (require.main === module) {
    const args = process.argv.slice(2);
    const getArg = (flag) => {
        const i = args.indexOf(flag);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const opts = {
        port: parseInt(getArg('--port')) || 3210,
        wsPort: parseInt(getArg('--ws-port')) || 3211,
        staticDir: getArg('--static') || path.join(__dirname, '..', 'test'),
    };
    new CastServer(opts).start();
}

module.exports = { CastServer };
