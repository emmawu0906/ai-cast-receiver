# AI Cast Receiver

纯Node.js实现的投屏接收端服务，无需任何npm依赖。

## 特性

- 🚀 零依赖 - 纯Node.js标准库实现
- 📱 跨平台 - 支持macOS/Windows/Linux
- 🎯 轻量级 - 单文件服务器，即开即用
- 🔐 投屏码认证 - 6位随机码安全连接
- 💓 心跳保活 - 15秒心跳，弱网自动重连
- 📡 实时推送 - SSE推送投屏事件到前端

## 快速开始

### 1. 启动服务

```bash
node test/server.js
```

服务将在以下端口启动：
- HTTP服务：`http://localhost:3210`
- WebSocket：`ws://localhost:3211`

### 2. 获取投屏码

浏览器打开 `http://localhost:3210`，页面会显示6位投屏码。

### 3. 手机连接

在手机APP中输入投屏码即可连接。

## API接口

### HTTP API

#### 获取设备信息
```
GET /api/info
```

返回：
```json
{
  "hostname": "MacBook-Pro",
  "platform": "darwin",
  "arch": "arm64",
  "cpus": 10,
  "memory": "16.0 GB",
  "uptime": "2 hours",
  "user": "username",
  "node": "v18.0.0"
}
```

#### 执行命令
```
POST /api/cmd
Content-Type: application/json

{
  "action": "open_url",
  "url": "https://example.com"
}
```

支持的action：
- `open_url` - 打开网址
- `play_video` - 播放视频
- `show_image` - 显示图片
- `notify` - 系统通知

### WebSocket协议

连接：`ws://localhost:3211`

#### 客户端→服务器

```json
{
  "type": "auth",
  "code": "123456"
}
```

```json
{
  "type": "cast",
  "action": "open_url",
  "url": "https://example.com"
}
```

#### 服务器→客户端

```json
{
  "type": "auth_result",
  "success": true
}
```

```json
{
  "type": "heartbeat_ack"
}
```

## 目录结构

```
ai-cast-receiver/
├── test/
│   └── server.js          # 测试服务器（完整功能）
├── sdk/
│   ├── cast-receiver.js   # 接收端SDK
│   ├── cast-sender.js     # 发送端SDK
│   ├── cast-server.js     # 服务端SDK
│   └── README.md          # SDK文档
└── README.md
```

## 配置

编辑 `test/server.js` 修改端口：

```javascript
const PORT = 3210;      // HTTP端口
const WS_PORT = 3211;   // WebSocket端口
```

## 安全说明

- 投屏码每次启动随机生成
- 仅支持局域网连接
- 建议在防火墙中限制端口访问

## 系统要求

- Node.js >= 14.0.0
- 无其他依赖

## License

MIT
