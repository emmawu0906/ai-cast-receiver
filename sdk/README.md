# AI投屏 Cast SDK v1.0.0

通用投屏 SDK，**3 行代码**让任意 Web APP 实现发端投屏 + 收端指令接收。

## 文件说明

| 文件 | 用途 | 运行环境 |
|------|------|---------|
| `cast-sender.js` | 发端 SDK，发送投屏指令 | 浏览器 / H5 / Node.js |
| `cast-receiver.js` | 收端 SDK，接收指令回调 | 浏览器 / Node.js |
| `cast-server.js` | 中继服务器（零 npm 依赖） | Node.js |

---

## 快速开始

### 1. 启动中继服务器

```bash
node cast-server.js
# 默认端口 3210 (HTTP) + 3211 (WebSocket)
# 自定义: node cast-server.js --port 8080 --static ./www
```

### 2. 发端接入（手机/H5 APP）

```html
<script src="cast-sender.js"></script>
<script>
const sender = new CastSender({ serverUrl: 'http://192.168.1.10:3210' });

sender.on('connect', (info) => console.log('已连接', info.hostname));
sender.on('result',  (res)  => console.log('执行结果', res));
sender.on('error',   (err)  => console.error(err));

sender.connect();

// 发送指令
sender.send('openUrl', 'https://example.com');
sender.send('shell', 'date');
sender.send('notify', { title: '标题', body: '消息内容' });
sender.send('say', '你好世界');
sender.send('screenshot');
</script>
```

### 3. 收端接入（电脑/投影大屏页面）

```html
<script src="cast-receiver.js"></script>
<script>
const receiver = new CastReceiver({ serverUrl: 'http://localhost:3210' });

receiver.on('connect',  ()    => console.log('已连接到服务器'));
receiver.on('command',  (cmd) => console.log('收到指令', cmd.type, cmd.data));
receiver.on('result',   (res) => console.log('执行结果', res));
receiver.on('disconnect', ()  => console.log('连接断开，自动重连中...'));

// 也可以单独监听特定指令类型
receiver.on('openUrl',  (data) => window.open(data));
receiver.on('say',      (text) => console.log('播报:', text));

receiver.connect();
</script>
```

---

## 指令参考

| type | data 示例 | 说明 |
|------|-----------|------|
| `openUrl` | `"https://..."` | 在收端打开 URL |
| `openFile` | `"/path/to/file"` | 打开文件 |
| `notify` | `{ title, body }` | 系统通知 |
| `say` | `"文字内容"` | TTS 语音播报 |
| `screenshot` | `null` | 截图 |
| `shell` | `"date"` | 执行白名单命令 |
| `getInfo` | `null` | 获取设备信息 |
| `custom` | `{ ... }` | 自定义扩展指令 |

---

## 服务器高级用法（模块引入）

```js
const { CastServer } = require('./cast-server');

const server = new CastServer({
    port: 3210,
    wsPort: 3211,
    staticDir: __dirname,          // 静态文件根目录
    allowedCommands: ['date','ls'], // shell 白名单（null 关闭 shell）
    appName: '我的产品',
});

// 自定义指令处理（拦截所有 command 事件）
server.on('command', (cmd, reply) => {
    if (cmd.type === 'myCustomAction') {
        doSomething(cmd.data);
        reply({ success: true, custom: true });
    }
    // 不 reply 则走内置处理
});

// 处理未知指令
server.on('unknownCommand', (cmd, reply) => {
    reply({ success: false, error: '未知: ' + cmd.type });
});

server.on('start', ({ ip, port }) => {
    console.log(`服务已启动: http://${ip}:${port}`);
});

server.start();
```

---

## CastSender API

```js
const sender = new CastSender({ serverUrl, timeout, retryDelay, autoConnect });

sender.connect()                         // 连接服务器
sender.disconnect()                      // 断开
sender.send(type, data)                  // → Promise<result>
sender.openUrl(url)                      // 快捷方法
sender.openFile(path)
sender.notify(title, body)
sender.say(text)
sender.shell(command)
sender.screenshot()
sender.getInfo()
sender.isConnected()                     // → boolean
sender.getDeviceInfo()                   // → Object

sender.on('connect', (info) => {})
sender.on('result',  (res)  => {})
sender.on('error',   (err)  => {})
sender.on('disconnect', () => {})
```

## CastReceiver API

```js
const receiver = new CastReceiver({ serverUrl, retryDelay, autoConnect });

receiver.connect()
receiver.disconnect()
receiver.isConnected()                   // → boolean

receiver.on('connect',    ()    => {})
receiver.on('disconnect', ()    => {})
receiver.on('command',    (cmd) => {})   // cmd = { type, data, ts }
receiver.on('result',     (res) => {})
receiver.on('<type>',     (data)=> {})   // 按指令类型单独监听
```

---

## 注意事项

- 发端和收端需与服务器在**同一局域网**
- `shell` 指令默认仅允许只读命令，可通过 `allowedCommands` 配置
- `openUrl` / `openFile` / `say` / `screenshot` 仅在 **macOS** 上有内置实现，其他平台需通过 `command` 钩子自行处理
- SSE 断线会自动重连（默认 3 秒）
