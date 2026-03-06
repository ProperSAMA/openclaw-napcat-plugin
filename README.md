# OpenClaw NapCat Plugin

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

QQ 聊天通道插件 for OpenClaw，基于 NapCat (OneBot 11) 实现。
部署完毕后，可通过 QQ 与 OpenClaw 对话、下达指令

## 功能特性

- ✅ 接收私聊和群组消息
- ✅ 支持文本消息收发
- ✅ 支持群聊/私聊 sessionKey 路由
- ✅ 支持图片等媒体发送（CQ:image）
- ✅ 可配置的接收用户白名单
- ✅ 完整的消息路由和会话管理
- ✅ 与 OpenClaw 无缝集成

## 安装方法

1. clone 或直接下载 zip，记住路径
```bash
git clone https://github.com/ProperSAMA/openclaw-napcat-plugin.git
```
2. 安装插件: `openclaw plugins install <路径>`
3. 将 `skill` 路径中的 `napcat-qq` 放入 OpenClaw 的 skill 目录中
4. 按需求修改配置文件 `openclaw.json`
5. 重启 OpenClaw Gateway: `openclaw gateway restart`

## 配置方法

在 `~/.openclaw/openclaw.json` 中添加或修改 `channels.napcat` 配置：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "agentId": "main",
      "transport": "http",
      "url": "http://127.0.0.1:3000",
      "token": "napcat",
      "wsUrl": "ws://127.0.0.1:3001/",
      "wsHost": "0.0.0.0",
      "wsPort": 3001,
      "wsPath": "/",
      "wsToken": "napcat",
      "wsHeartbeatMs": 30000,
      "wsReconnectMs": 30000,
      "wsRequestTimeoutMs": 10000,
      "inboundMediaDir": "./workspace/napcat-inbound-media",
      "inboundImageEnabled": true,
      "inboundImagePreferUrl": true,
      "allowUsers": [
        "123456789",
        "987654321"
      ],
      "enableGroupMessages": true,
      "groupMentionOnly": true,
      "mediaProxyEnabled": true,
      "publicBaseUrl": "http://127.0.0.1:18789",
      "voiceBasePath": "/your/voice/path",
      "enableInboundLogging": true,
      "inboundLogDir": "/your/inbound/log/dir"
    }
  },
  "plugins": {
    "entries": {
      "napcat": {
        "enabled": true
      }
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 说明 | 默认值 |
|--------|------|------|--------|
| `transport` | string | 传输模式：`http` / `ws-client` / `ws-server` | `http` |
| `url` | string | NapCat HTTP 服务地址 | `http://127.0.0.1:3000` |
| `token` | string | NapCat HTTP 访问令牌（自动以 Bearer + access_token 发送） | `""` |
| `wsUrl` | string | `ws-client` 模式连接地址（例如 `ws://127.0.0.1:3001/`） | `""` |
| `wsHost` | string | `ws-server` 监听地址（也作为 `ws-client` 的回退 host） | `0.0.0.0` |
| `wsPort` | number | `ws-server` 监听端口（也作为 `ws-client` 的回退 port） | `3001` |
| `wsPath` | string | WS 路径（例如 `/`、`/onebot/v11/ws`） | `/` |
| `wsToken` | string | WebSocket 鉴权令牌（Bearer + access_token） | `""` |
| `wsHeartbeatMs` | number | WS 心跳间隔（毫秒） | `30000` |
| `wsReconnectMs` | number | WS 重连间隔（毫秒，仅 `ws-client` 生效） | `30000` |
| `wsRequestTimeoutMs` | number | WS action 请求超时（毫秒） | `10000` |
| `agentId` | string | 可选，固定将 NapCat 会话绑定到该 OpenClaw agent（如 `main`、`ops`） | `""`（空=按默认路由） |
| `allowUsers` | string[] | 允许接收消息的 QQ 用户 ID 列表 | `[]` (接收所有) |
| `enableGroupMessages` | boolean | 是否处理群消息 | `false` |
| `groupMentionOnly` | boolean | 群消息是否需要 @ 机器人 | `true` |
| `mediaProxyEnabled` | boolean | 启用 `/napcat/media` 媒体代理（跨设备发图推荐） | `false` |
| `publicBaseUrl` | string | OpenClaw 对 NapCat 可达的地址（如 `http://127.0.0.1:18789`） | `""` |
| `mediaProxyToken` | string | 媒体代理可选访问令牌 | `""` |
| `voiceBasePath` | string | 相对语音文件名的基础目录（例如 `/tmp/napcat-voice`） | `""` |
| `enableInboundLogging` | boolean | 是否记录入站消息日志 | `true` |
| `inboundLogDir` | string | 入站日志目录 | `"./logs/napcat-inbound"` |
| `inboundImageEnabled` | boolean | 是否解析入站 CQ:image/CQ:record 为多模态输入 | `true` |
| `inboundImagePreferUrl` | boolean | 解析图片时是否优先使用 CQ 中的 `url` 字段（否则优先 `file`） | `true` |
| `inboundMediaDir` | string | 入站媒体本地缓存目录，插件会先下载到这里再交给 OpenClaw | `"./workspace/napcat-inbound-media"` |

**群消息说明：**
- `enableGroupMessages: false`（默认）：完全忽略群消息
- `enableGroupMessages: true, groupMentionOnly: true`：只有 @ 机器人时才处理
- `enableGroupMessages: true, groupMentionOnly: false`：处理所有群消息（不推荐）

### 传输模式说明

- `transport: "http"`：兼容原有 HTTP Server + HTTP Client 方式（默认推荐）
- `transport: "ws-client"`：OpenClaw 主动连接 NapCat 的 WebSocket Server
- `transport: "ws-server"`：OpenClaw 提供 WebSocket Server，NapCat 以 WebSocket Client 反向连接

说明：
- HTTP/WS 均支持 `token` 鉴权（同时发送 `Authorization: Bearer <token>` 与 `access_token` 查询参数）。
- `wsReconnectMs` 仅 `ws-client` 使用；`ws-server` 模式无重连参数（由 NapCat 客户端负责重连）。

## NapCat 配置（HTTP）

在 NapCat 网络配置界面新建以下网络配置并启用：

Http 服务器
- Host: 0.0.0.0
- Port: 3000

Http 客户端
- Url: `http://127.0.0.1:18789/napcat`
- 消息格式: String

如果 OpenClaw 运行在不同的机器上，请在 Http 客户端中使用实际 IP 地址。

## NapCat 配置（WebSocket）

### 方式 A：OpenClaw 使用 `ws-client`（连接 NapCat WS 服务器）

NapCat 新建并启用 `Websocket 服务器`：
- Host: `0.0.0.0`
- Port: `3001`
- Token: `napcat`（与 `wsToken` 对应）
- 心跳间隔：建议 `30000`
- 消息格式：建议 `Array`

OpenClaw 示例：

```json
{
  "channels": {
    "napcat": {
      "transport": "ws-client",
      "wsUrl": "ws://1Panel-localnapcat-sGYW:3001/",
      "wsToken": "napcat",
      "wsHeartbeatMs": 30000,
      "wsReconnectMs": 30000
    }
  }
}
```

### 方式 B：OpenClaw 使用 `ws-server`（NapCat WS 客户端反向连接）

NapCat 新建并启用 `Websocket 客户端`：
- URL: `ws://<OpenClaw可达地址>:3001/`
- Token: `napcat`（与 `wsToken` 对应）
- 心跳间隔：建议 `30000`
- 重连间隔：建议 `30000`
- 消息格式：建议 `Array`

OpenClaw 示例：

```json
{
  "channels": {
    "napcat": {
      "transport": "ws-server",
      "wsHost": "0.0.0.0",
      "wsPort": 3001,
      "wsPath": "/",
      "wsToken": "napcat",
      "wsHeartbeatMs": 30000
    }
  }
}
```

两种方式都建议先确保容器间网络互通，再切换生产配置。

## 入站图片识别说明

当 QQ 通过 NapCat 发送图片（`[CQ:image,...]`）或语音（`[CQ:record,...]`）时：

- 插件会在入站阶段解析 CQ 段：
  - 提取 `url` / `file`，生成图片/音频 URL 列表
  - 将纯文本中的图片 CQ 片段剥离，只保留用户正文
- 为了兼容容器环境与远程模型取图限制，插件会优先把入站图片/语音下载到 OpenClaw 本地缓存目录，再通过 `MediaPath` / `MediaPaths` / `MediaType` / `MediaTypes` 交给 OpenClaw。
- 解析结果会注入到 OpenClaw 上下文中，例如：
  - `MediaUrls` / `MediaUrl`
  - `ImageUrls` / `Images`
  - `MediaPath` / `MediaPaths`
  - `MediaType` / `MediaTypes`
  - `AudioUrls` / `Audios`
- 上层 agent 会把这些媒体作为多模态输入交给模型，从而真正看到图片/语音，而不是只看到 `[CQ:image,...]` 这一串文本。

相关配置：

- `inboundImageEnabled`: 控制是否启用入站 CQ 媒体解析（默认启用）
- `inboundImagePreferUrl`: 控制在 CQ 同时提供 `url` 和 `file` 时优先使用哪一个（默认优先 `url`）

## 发送消息说明

为了确保正确路由，请明确指定 `channel: "napcat"`，并使用以下目标格式：

私聊目标
- `private:<QQ号>`
- `session:napcat:private:<QQ号>`

群聊目标
- `group:<群号>`
- `session:napcat:group:<群号>`

注意：纯数字 `target` 会被当作私聊用户 ID，群聊请务必加上 `group:` 或 `session:napcat:group:` 前缀。

## 跨设备图片发送（临时媒体 HTTP 服务）

当 OpenClaw 与 NapCat 在不同设备时，建议开启媒体代理，让 NapCat 通过 OpenClaw 提供的 HTTP 地址拉取图片：

```json
{
  "channels": {
    "napcat": {
      "url": "http://192.168.1.20:3000",
      "mediaProxyEnabled": true,
      "publicBaseUrl": "http://192.168.1.10:18789",
      "mediaProxyToken": "change-me"
    }
  }
}
```

- 插件会把 `mediaUrl` 自动改写为 `http://<OpenClaw>/napcat/media?...` 供 NapCat 访问。
- 若设置了 `mediaProxyToken`，NapCat 拉取时必须携带匹配令牌。
- 请确保 NapCat 设备能访问 `publicBaseUrl` 对应地址与端口。

## 语音发送（WAV）

- 当 `mediaUrl` 是音频后缀（如 `.wav`）时，插件会自动按语音消息发送（`CQ:record`）。
- 若 `mediaUrl` 是相对文件名（如 `test.wav`），会自动拼接 `voiceBasePath`（例如 `/tmp/napcat-voice/test.wav`）。
- 开启媒体代理后，语音文件也会走 `/napcat/media`，适合 OpenClaw 与 NapCat 分机部署。

## Skill（napcat-qq）

本仓库包含 Skill：`skill/napcat-qq`，用于强制使用本插件发送 QQ 消息并规范 sessionKey。

## 开发

### 项目结构

```
openclaw-napcat-plugin/
├── index.ts              # 插件入口
├── openclaw.plugin.json  # 插件元数据
├── package.json          # npm 配置
├── src/
│   ├── channel.ts        # 通道实现（发送消息）
│   ├── runtime.ts        # 运行时状态管理
│   ├── webhook.ts        # HTTP 入站处理（接收消息）
│   └── ws.ts             # WebSocket 传输层（client/server）
```

## 许可证

MIT License

## 致谢

- [OpenClaw](https://openclaw.ai)
- [NapCat](https://github.com/NapCatQQ/NapCat)
