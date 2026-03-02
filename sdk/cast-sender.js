/*!
 * cast-sender.js — AI投屏 发端 SDK v1.0.0
 * 任意 Web/H5 APP 集成后即可向收端发送投屏指令
 *
 * 用法:
 *   <script src="cast-sender.js"></script>
 *   const sender = new CastSender({ serverUrl: 'http://192.168.1.x:3210' });
 *   sender.on('connect', () => console.log('已连接'));
 *   sender.on('result', (res) => console.log(res));
 *   sender.connect();
 *   sender.send('openUrl', 'https://example.com');
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(); // Node / CommonJS
    } else {
        root.CastSender = factory(); // 浏览器全局
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
    // CastSender
    // ─────────────────────────────────────────────────
    /**
     * @param {Object} opts
     * @param {string}  opts.serverUrl     服务器地址, e.g. 'http://192.168.1.10:3210'
     * @param {number}  [opts.timeout=8000]   请求超时 ms
     * @param {number}  [opts.retryDelay=3000] 重连间隔 ms
     * @param {boolean} [opts.autoConnect=false] 是否立即自动连接
     */
    function CastSender(opts) {
        EventEmitter.call(this);
        opts = opts || {};
        this.serverUrl = (opts.serverUrl || 'http://localhost:3210').replace(/\/$/, '');
        this.timeout = opts.timeout || 8000;
        this.retryDelay = opts.retryDelay || 3000;
        this._connected = false;
        this._retryTimer = null;
        this._deviceInfo = null;

        if (opts.autoConnect) this.connect();
    }

    CastSender.prototype = Object.create(EventEmitter.prototype);
    CastSender.prototype.constructor = CastSender;

    // ── connect ────────────────────────────────────────
    /** 探测服务器连通性，成功则触发 'connect' 事件 */
    CastSender.prototype.connect = function () {
        var self = this;
        self._fetch(self.serverUrl + '/api/info')
            .then(function (info) {
                self._connected = true;
                self._deviceInfo = info;
                self.emit('connect', info);
            })
            .catch(function (err) {
                self._connected = false;
                self.emit('error', err);
                self._scheduleRetry();
            });
        return this;
    };

    // ── disconnect ─────────────────────────────────────
    CastSender.prototype.disconnect = function () {
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        this._connected = false;
        this.emit('disconnect');
        return this;
    };

    // ── send ───────────────────────────────────────────
    /**
     * 发送投屏指令
     * @param {string} type   指令类型 ('openUrl'|'openFile'|'notify'|'say'|'shell'|'screenshot'|'getInfo'|'custom')
     * @param {*}      data   指令数据
     * @returns {Promise}     解析为服务器返回的结果
     */
    CastSender.prototype.send = function (type, data) {
        var self = this;
        var payload = JSON.stringify({ type: type, data: data, ts: Date.now() });

        return self._fetch(self.serverUrl + '/api/cmd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        }).then(function (result) {
            self.emit('result', result);
            return result;
        }).catch(function (err) {
            self.emit('error', err);
            throw err;
        });
    };

    // ── convenience aliases ────────────────────────────
    CastSender.prototype.openUrl = function (url) { return this.send('openUrl', url); };
    CastSender.prototype.openFile = function (path) { return this.send('openFile', path); };
    CastSender.prototype.notify = function (title, body) { return this.send('notify', { title: title, body: body }); };
    CastSender.prototype.say = function (text) { return this.send('say', text); };
    CastSender.prototype.shell = function (cmd) { return this.send('shell', cmd); };
    CastSender.prototype.screenshot = function () { return this.send('screenshot', null); };
    CastSender.prototype.getInfo = function () { return this.send('getInfo', null); };

    // ── state ──────────────────────────────────────────
    CastSender.prototype.isConnected = function () { return this._connected; };
    CastSender.prototype.getDeviceInfo = function () { return this._deviceInfo; };

    // ── internal ───────────────────────────────────────
    CastSender.prototype._scheduleRetry = function () {
        var self = this;
        if (self._retryTimer) return;
        self._retryTimer = setTimeout(function () {
            self._retryTimer = null;
            self.connect();
        }, self.retryDelay);
    };

    CastSender.prototype._fetch = function (url, opts) {
        return new Promise(function (resolve, reject) {
            var done = false;
            var timer = setTimeout(function () {
                if (!done) { done = true; reject(new Error('Request timeout: ' + url)); }
            }, this.timeout);

            var fetchFn = typeof fetch !== 'undefined' ? fetch : null;
            if (!fetchFn) {
                // Node.js 环境
                var http = require(url.startsWith('https') ? 'https' : 'http');
                var parsed = new (require('url').URL)(url);
                var bodyStr = opts && opts.body ? opts.body : null;

                var reqOpts = {
                    hostname: parsed.hostname, port: parsed.port,
                    path: parsed.pathname + parsed.search,
                    method: (opts && opts.method) || 'GET',
                    headers: (opts && opts.headers) || {},
                };
                if (bodyStr) reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);

                var req = http.request(reqOpts, function (res) {
                    var chunks = [];
                    res.on('data', function (c) { chunks.push(c); });
                    res.on('end', function () {
                        if (done) return;
                        done = true; clearTimeout(timer);
                        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                        catch (e) { reject(e); }
                    });
                });
                req.on('error', function (e) {
                    if (!done) { done = true; clearTimeout(timer); reject(e); }
                });
                if (bodyStr) req.write(bodyStr);
                req.end();
                return;
            }

            // 浏览器 fetch
            fetchFn(url, opts)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (!done) { done = true; clearTimeout(timer); resolve(data); }
                })
                .catch(function (e) {
                    if (!done) { done = true; clearTimeout(timer); reject(e); }
                });
        }.bind(this));
    };

    return CastSender;
}));
