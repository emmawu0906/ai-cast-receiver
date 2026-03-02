/*!
 * cast-receiver.js — AI投屏 收端 SDK v1.0.0
 * 任意收端页面集成后即可实时接收投屏指令
 *
 * 用法:
 *   <script src="cast-receiver.js"></script>
 *   const receiver = new CastReceiver({ serverUrl: 'http://localhost:3210' });
 *   receiver.on('command', (cmd) => { /* 处理指令 *\/ });
 *   receiver.on('result',  (res) => { /* 处理结果 *\/ });
 *   receiver.connect();
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.CastReceiver = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ─────────────────────────────────────────────────
    // 简易 EventEmitter
    // ─────────────────────────────────────────────────
    function EventEmitter() { this._listeners = {}; }
    EventEmitter.prototype.on = function (event, fn) {
        (this._listeners[event] = this._listeners[event] || []).push(fn);
        return this;
    };
    EventEmitter.prototype.off = function (event, fn) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = fn
            ? this._listeners[event].filter(function (f) { return f !== fn; })
            : [];
        return this;
    };
    EventEmitter.prototype.emit = function (event) {
        var args = Array.prototype.slice.call(arguments, 1);
        (this._listeners[event] || []).forEach(function (fn) { fn.apply(null, args); });
    };

    // ─────────────────────────────────────────────────
    // CastReceiver
    // ─────────────────────────────────────────────────
    /**
     * @param {Object}  opts
     * @param {string}  opts.serverUrl       服务器地址, e.g. 'http://localhost:3210'
     * @param {number}  [opts.retryDelay=3000]  SSE 断线重连间隔 ms
     * @param {boolean} [opts.autoConnect=false] 是否立即自动连接
     */
    function CastReceiver(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.serverUrl = (opts.serverUrl || 'http://localhost:3210').replace(/\/$/, '');
        this.retryDelay = opts.retryDelay || 3000;
        this._es = null;  // EventSource
        this._connected = false;
        this._retryTimer = null;

        if (opts.autoConnect) this.connect();
    }

    CastReceiver.prototype = Object.create(EventEmitter.prototype);
    CastReceiver.prototype.constructor = CastReceiver;

    // ── connect ────────────────────────────────────────
    /** 建立 SSE 连接，自动重连 */
    CastReceiver.prototype.connect = function () {
        var self = this;
        if (self._es) { try { self._es.close(); } catch (e) { } }

        var url = self.serverUrl + '/api/stream';

        // 浏览器：使用原生 EventSource
        if (typeof EventSource !== 'undefined') {
            var es = new EventSource(url);

            es.onopen = function () {
                self._connected = true;
                self.emit('connect');
            };

            es.addEventListener('connected', function () {
                self._connected = true;
                self.emit('connect');
            });

            es.addEventListener('command', function (e) {
                try {
                    var cmd = JSON.parse(e.data);
                    self.emit('command', cmd);
                    self.emit(cmd.type, cmd.data); // 也单独按类型触发
                } catch (err) { /* ignore */ }
            });

            es.addEventListener('result', function (e) {
                try {
                    var res = JSON.parse(e.data);
                    self.emit('result', res);
                } catch (err) { /* ignore */ }
            });

            es.onerror = function () {
                self._connected = false;
                self.emit('disconnect');
                es.close();
                self._scheduleRetry();
            };

            self._es = es;

        } else {
            // Node.js 环境：用 http 手动请求 SSE
            var http = require(url.startsWith('https') ? 'https' : 'http');
            var parsed = new (require('url').URL)(url);
            var req = http.request({
                hostname: parsed.hostname, port: parsed.port,
                path: parsed.pathname, method: 'GET',
                headers: { Accept: 'text/event-stream' },
            }, function (res) {
                self._connected = true;
                self.emit('connect');

                var buf = '';
                res.on('data', function (chunk) {
                    buf += chunk.toString();
                    var lines = buf.split('\n');
                    buf = lines.pop(); // 保留不完整行

                    var eventName = 'message', dataStr = '';
                    lines.forEach(function (line) {
                        if (line.startsWith('event:')) {
                            eventName = line.slice(6).trim();
                        } else if (line.startsWith('data:')) {
                            dataStr = line.slice(5).trim();
                        } else if (line === '') {
                            if (dataStr) {
                                try {
                                    var parsed = JSON.parse(dataStr);
                                    if (eventName === 'command') {
                                        self.emit('command', parsed);
                                        self.emit(parsed.type, parsed.data);
                                    } else if (eventName === 'result') {
                                        self.emit('result', parsed);
                                    } else {
                                        self.emit(eventName, parsed);
                                    }
                                } catch (e) { }
                            }
                            eventName = 'message'; dataStr = '';
                        }
                    });
                });

                res.on('end', function () {
                    self._connected = false;
                    self.emit('disconnect');
                    self._scheduleRetry();
                });
            });

            req.on('error', function () {
                self._connected = false;
                self.emit('disconnect');
                self._scheduleRetry();
            });
            req.end();
            self._es = req;
        }

        return this;
    };

    // ── disconnect ─────────────────────────────────────
    CastReceiver.prototype.disconnect = function () {
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        if (this._es) { try { this._es.close ? this._es.close() : this._es.destroy(); } catch (e) { } this._es = null; }
        this._connected = false;
        this.emit('disconnect');
        return this;
    };

    // ── state ──────────────────────────────────────────
    CastReceiver.prototype.isConnected = function () { return this._connected; };

    CastReceiver.prototype._scheduleRetry = function () {
        var self = this;
        if (self._retryTimer) return;
        self._retryTimer = setTimeout(function () {
            self._retryTimer = null;
            self.connect();
        }, self.retryDelay);
    };

    return CastReceiver;
}));
