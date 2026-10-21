# OpenClaw NapCat Plugin

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

这是一个给 **OpenClaw** 用的 **QQ 通道插件**。  
它通过 **NapCat（OneBot 11）** 把 QQ 私聊、群聊接进 OpenClaw，让你可以直接在 QQ 里和 OpenClaw 对话。

如果你不是程序员，也没关系。你可以把它理解成：

- **OpenClaw** = 大脑
- **NapCat** = QQ 适配器
- **这个插件** = 把两边接起来的桥

配好以后，你就可以：

- 在 QQ 私聊里直接找 OpenClaw
- 在 QQ 群里 @ 它让它回复
- 给 QQ 群发送图片、语音，甚至上传文件

---

## 功能特性

- 私聊消息收发
- 群聊消息收发（支持 @ 触发）
- 读取合并转发消息（`CQ:forward`）
- 图片发送
- 语音发送（WAV 等音频）
- 群文件上传
- QQ 消息表情回应（reaction）
- 收到消息后自动添加确认表情（复用 OpenClaw `messages.ackReaction` 配置）
- 白名单控制（只允许指定 QQ 号触发）
- 入站消息日志记录
- 私聊处理中显示"正在输入"
- 进度消息（commentary）投递

---

## 快速开始

### 前置要求

- 一个能正常运行的 **OpenClaw**
- 一个能正常运行的 **NapCat**
- 能编辑 `~/.openclaw/openclaw.json`
- 能重启 OpenClaw Gateway

### 安装步骤

#### 1. 安装插件

```bash
openclaw plugins install @propersama/openclaw-napcat
```

#### 2. 启用插件

```bash
openclaw plugins enable napcat
```

#### 3. 配置 OpenClaw

编辑 `~/.openclaw/openclaw.json`，加入：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "http://127.0.0.1:15150",
      "webhookSecret": "替换为随机签名密钥",
      "streaming_mode": false,
      "enablePrivateTypingStatus": true,
      "enableGroupMessages": true,
      "groupWhitelist": [],
      "groupMentionOnly": true
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

#### 4. 重启 Gateway

```bash
openclaw gateway restart
```

#### 5. 配置 NapCat

在 NapCat 的网络配置界面，新增并启用：

**A. Http 服务器**
- Host: `0.0.0.0`
- Port: `15150`

**B. Http 客户端**
- Url: `http://127.0.0.1:18789/napcat`
- 消息格式: `String`
- Token: 与 OpenClaw 的 `channels.napcat.webhookSecret` 完全一致

入站请求必须携带 NapCat 生成的 `x-signature`（原始请求体的 HMAC-SHA1）。未配置密钥返回 503，缺失或无效签名返回 403；`token` 仍仅用于出站 HTTP API。升级旧配置时必须补齐双方的签名密钥。

如果 OpenClaw 和 NapCat 不在同一台机器上，把 `127.0.0.1` 改成 OpenClaw 的真实 IP。

#### 6. 测试

- **私聊**：直接给对应 QQ 发消息
- **群聊**：在群里发 `@机器人 你好`

---

## 配置说明

### 基础配置

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `enabled` | boolean | 是否启用 napcat 通道 | `false` |
| `url` | string | NapCat 的 HTTP 服务地址 | `http://127.0.0.1:15150` |
| `webhookSecret` | string | 必填，与 NapCat HTTP 客户端 Token 相同的入站签名密钥 | `""` |
| `token` | string | NapCat HTTP 服务器的出站 API Bearer Token | `""` |
| `agentId` | string | 固定把消息交给哪个 OpenClaw agent 处理；留空时按 OpenClaw 路由 | `""` |

### 权限控制

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `allowUsers` | string[] | 只允许这些 QQ 号触发机器人；空数组表示不过滤 | `[]` |
| `enableGroupMessages` | boolean | 是否处理群消息 | `false` |
| `groupWhitelist` | string[] | 只允许这些群号触发机器人；空数组表示不过滤群 | `[]` |
| `groupMentionOnly` | boolean | 群里是否必须 @ 机器人才处理 | `true` |

### 消息处理

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `streaming_mode` | boolean | 是否启用流式传输模式；开启后会按处理步骤连续发送 QQ 消息 | `false` |
| `plainTextMode` | boolean | 是否把发往 QQ 的 Markdown 风格文字转成纯文本 | `true` |
| `enablePrivateTypingStatus` | boolean | 是否在私聊处理中显示 QQ "正在输入" | `true` |
| `enable_progress_messages` | boolean | 是否将 OpenClaw 的 commentary 进度消息投递到 QQ | `false` |
| `groupReplyQuote` | boolean | 群聊回复改用引用触发消息（`[CQ:reply]`），而不是 @ 发送者 | `false` |
| `conversationConfigDir` | string | 分会话配置目录（`default.json` 加 `<group\|private>-<id>.json`）；目录不存在则该特性静默不生效 | `~/.openclaw/napcat/conversations` |

**重要前提**：`groupReplyQuote` 依赖 `messages.queue.mode = "followup"`（`openclaw config set
messages.queue.mode followup`）。默认的 `steer` 会把同一会话里并发到达的消息折进正在跑的那一轮，
两条消息的回复就会带上同一条消息的 id，表现是「连发两条，都引用第一条」。

### 分会话配置

`conversationConfigDir` 下的 JSON 可以按会话覆盖行为类配置项，优先级由低到高：
`channels.napcat` → `default.json` → `<group|private>-<id>.json`（会话 id 里的 `:` 换成 `-`）。
目录不存在时该特性静默不生效；文件改完存盘即生效，不需要重启。

连接类键（`url`、`token`、`mediaProxy*` 等）不在覆盖范围内，写了会被忽略并打 warning。

可覆盖的键：`groupReplyQuote`、`streaming_mode`、`enable_progress_messages`、
`plainTextMode`、`groupMentionOnly`、`enablePrivateTypingStatus`、`agentId`。

### 媒体代理（跨机器部署）

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `mediaProxyEnabled` | boolean | 是否开启媒体代理，解决跨机器图片/语音发送问题 | `false` |
| `publicBaseUrl` | string | OpenClaw 对 NapCat 可访问的地址 | `""` |
| `mediaProxyToken` | string | 媒体代理访问令牌；启用代理时必填 | `""` |
| `mediaProxyAllowedRoots` | string[] | 允许代理读取本地媒体的宿主机绝对目录 | `[]` |

### 语音和文件

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `voiceBasePath` | string | 相对语音文件名的基础目录 | `""` |
| `groupFileFolder` | string | 群文件默认上传目录 | `""` |
| `groupFileHostPrefix` | string | 宿主机上已挂载进容器的目录前缀 | `""` |
| `groupFileContainerPrefix` | string | 上面那个目录在容器里的对应路径 | `""` |
| `groupFileStageHostDir` | string | 宿主机上的上传暂存目录 | `""` |
| `groupFileStageContainerDir` | string | 上面暂存目录在容器里的对应路径 | `""` |

### 日志

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `enableInboundLogging` | boolean | 是否记录收到的消息日志 | `true` |
| `inboundLogDir` | string | 入站日志目录 | `./logs/napcat-inbound` |

---

## 使用指南

### 发消息目标格式

#### 私聊

- `private:<QQ号>`
- `session:napcat:private:<QQ号>`

例如：`private:123456789`

#### 群聊

- `group:<群号>`
- `session:napcat:group:<群号>`

例如：`group:123456789`

**注意**：只写纯数字会被当成私聊 QQ 号，发群消息一定要加 `group:` 前缀。

---

### 群聊工作模式

#### 模式 1：完全不处理群消息

```json
{
  "enableGroupMessages": false
}
```

适合：只想做私聊助手。

#### 模式 2：处理群消息，但必须 @ 机器人（推荐）

```json
{
  "enableGroupMessages": true,
  "groupWhitelist": ["123456789"],
  "groupMentionOnly": true
}
```

适合：大多数群聊场景。

#### 模式 3：处理所有群消息（不推荐）

```json
{
  "enableGroupMessages": true,
  "groupMentionOnly": false
}
```

适合：你非常确定需要"全群监听"。

---

### 自动确认表情（👀）

机器人收到符合处理条件的消息后，可以立即添加一个 QQ 表情回应。

配置位于 `openclaw.json` 顶层的 `messages` 字段：

```json
{
  "messages": {
    "ackReaction": "👀",
    "ackReactionScope": "group-mentions",
    "removeAckAfterReply": false
  }
}
```

- `ackReaction`：Unicode Emoji 或 QQ 数字表情 ID
- `ackReactionScope`：
  - `group-mentions`：仅群聊中被 @ 的消息（默认）
  - `group-all`：所有会被机器人处理的群消息
  - `direct`：仅私聊消息
  - `all`：群聊和私聊消息
  - `off`：完全关闭
- `removeAckAfterReply`：回复完成后是否撤销表情，默认 `false`

---

### 进度消息（commentary）

`enable_progress_messages` 控制是否把 OpenClaw 的 commentary 进度消息（比如工具调用过程中的中间状态）投递到 QQ。

**重要前提**：OpenClaw 核心的 commentary 消息投递依赖 verbose 模式。如果 verbose 是关闭的（默认就是关闭），即使 `enable_progress_messages` 设为 `true`，进度消息也不会产生。

所以你需要同时开启 verbose：

**方法 1：单次会话开启（临时）**
```
/verbose on
```

**方法 2：全局默认开启（推荐）**

在 `openclaw.json` 里设置：

```json
{
  "agents": {
    "defaults": {
      "verboseDefault": "on"
    }
  }
}
```

---

### 图片和语音发送

#### 图片

插件支持把图片当作 QQ 图片消息发送。

#### 语音

如果媒体链接是这些后缀之一，会自动按语音消息发送：

- `.wav`
- `.mp3`
- `.amr`
- `.silk`
- `.ogg`
- `.m4a`
- `.flac`
- `.aac`

#### `voiceBasePath` 的作用

如果你传的是相对文件名（如 `test.wav`），插件会拼接成 `<voiceBasePath>/test.wav`。

---

### 跨机器部署（媒体代理）

从 1.0.13 起，图片和语音默认在 OpenClaw 侧安全加载后通过 Base64 发送，跨机器部署无需为此开启媒体代理。`/napcat/media` 仍可作为可选的受鉴权媒体读取端点；需要使用该端点时配置如下：

```json
{
  "channels": {
    "napcat": {
      "url": "http://192.168.1.20:15150",
      "webhookSecret": "与 NapCat HTTP 客户端 Token 一致",
      "mediaProxyEnabled": true,
      "publicBaseUrl": "http://192.168.1.10:18789",
      "mediaProxyToken": "请替换成足够长的随机令牌",
      "mediaProxyAllowedRoots": ["/srv/openclaw/media"]
    }
  }
}
```

- `publicBaseUrl` 必须是 NapCat 能访问到的地址
- 启用代理时必须设置非空 `mediaProxyToken`，否则代理会拒绝服务
- 本地文件必须位于 `mediaProxyAllowedRoots` 或 `voiceBasePath` 下；空列表不会授权任意目录
- 远程 URL 会经过 OpenClaw 的 SSRF 防护、DNS 固定和逐跳重定向检查
- 单个媒体最大 25 MiB，并受请求与分块读取超时约束；仅接受图片和音频，主动拒绝 SVG
- token 会出现在 NapCat 回取的查询参数中，请使用 HTTPS，并避免让反向代理记录查询串
- 防火墙 / Docker 端口映射 / 局域网访问都要打通

从旧版本升级时，如果原配置仅设置了 `mediaProxyEnabled: true`，必须补齐 token；需要代理本地文件时还要显式增加允许目录。这是有意的安全收紧。

---

### 群文件上传

当目标是群且传的是本地文件路径时，插件会自动按"群文件上传"处理。

#### Docker 部署注意事项

如果 NapCat 在 Docker 容器里，需要提供"宿主机目录 ↔ 容器目录"的映射。

**方案 A：使用已挂载路径**

```json
{
  "channels": {
    "napcat": {
      "groupFileHostPrefix": "/Users/yourname/shared",
      "groupFileContainerPrefix": "/app/shared"
    }
  }
}
```

**方案 B：使用暂存目录（更通用）**

```json
{
  "channels": {
    "napcat": {
      "groupFileStageHostDir": "/Users/yourname/Docker/napcat/plugins/openclaw-upload",
      "groupFileStageContainerDir": "/app/napcat/plugins/openclaw-upload"
    }
  }
}
```

插件会把文件复制到暂存目录，告诉 NapCat 读取容器内路径，上传完成后自动清理。

---

### 按昵称或备注找 QQ / 群

插件提供了一个联系人搜索脚本，适合配合 `skill/napcat-qq` 一起用。

**注意**：这个脚本默认**不会**随 npm 包一起安装，需要手动复制：

```bash
# 从仓库复制到本地 skill 目录
cp skill/napcat-qq/scripts/qq-contact-search.js ~/.openclaw/skills/napcat-qq/scripts/
```

用法：

```bash
node skill/napcat-qq/scripts/qq-contact-search.js 小明
node skill/napcat-qq/scripts/qq-contact-search.js 测试群 group
node skill/napcat-qq/scripts/qq-contact-search.js 老王 private
```

---

### 按群路由到不同 agent

在 `openclaw.json` 里用 `bindings` 为特定群指定 agent：

```json
{
  "bindings": [
    {
      "agentId": "xxx",
      "match": {
        "channel": "napcat",
        "peer": {
          "kind": "group",
          "id": "群号1"
        }
      }
    }
  ]
}
```

---

## 完整配置示例

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "agentId": "main",
      "url": "http://127.0.0.1:15150",
      "webhookSecret": "替换为随机签名密钥",
      "allowUsers": ["123456789", "987654321"],
      "enableGroupMessages": true,
      "groupWhitelist": ["123456789", "987654321"],
      "groupMentionOnly": true,
      "plainTextMode": true,
      "streaming_mode": false,
      "enablePrivateTypingStatus": true,
      "enable_progress_messages": false,
      "mediaProxyEnabled": true,
      "publicBaseUrl": "http://127.0.0.1:18789",
      "mediaProxyToken": "change-me",
      "mediaProxyAllowedRoots": ["/your/media/path"],
      "voiceBasePath": "/your/voice/path",
      "groupFileFolder": "",
      "groupFileHostPrefix": "",
      "groupFileContainerPrefix": "",
      "groupFileStageHostDir": "",
      "groupFileStageContainerDir": "",
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

---

## 常见问题

### 1. 私聊能用，群里没反应

检查：

- `enableGroupMessages` 有没有设成 `true`
- `groupWhitelist` 有没有把当前群拦掉
- `groupMentionOnly` 是否开启
- 你在群里有没有真的 @ 到机器人
- `allowUsers` 有没有把发消息的人拦掉

### 2. 消息到了 NapCat，但 OpenClaw 没回复

检查：

- NapCat 的 Http 客户端 URL 是否正确
- OpenClaw Gateway 是否正在运行
- 插件是否真的安装并启用
- 查看 `inboundLogDir` 里的日志

### 3. 文字能发，图片发不出去

大概率是：

- OpenClaw 和 NapCat 不在同一台机器上
- `mediaProxyEnabled` 没开
- `publicBaseUrl` 填错了
- `mediaProxyToken` 没有配置或不匹配
- 本地文件不在 `mediaProxyAllowedRoots` / `voiceBasePath` 允许范围内
- NapCat 根本访问不到 OpenClaw 提供的媒体地址

### 4. 群文件上传失败

大概率是路径问题：

- 你传的不是本地文件路径
- NapCat 容器看不到这个文件
- `groupFileHostPrefix / groupFileContainerPrefix` 没配置好
- 或者 `groupFileStageHostDir / groupFileStageContainerDir` 没配置好

### 5. 纯数字 target 发错地方了

只写纯数字会被当成私聊，发群消息请明确写 `group:<群号>`。

---

## 项目结构

```text
openclaw-napcat-plugin/
├── index.ts              # 插件入口
├── openclaw.plugin.json  # 插件元数据
├── package.json          # 包信息
├── src/
│   ├── channel.ts        # 消息发送逻辑
│   ├── runtime.ts        # 运行时状态
│   └── webhook.ts        # 接收 NapCat webhook
└── skill/
    └── napcat-qq         # 配套 skill
        └── scripts/
            └── qq-contact-search.js   # 联系人搜索脚本，npm 包默认不包含
```

---

## License

MIT License

---

## 致谢

- [OpenClaw](https://openclaw.ai)
- [NapCat](https://github.com/NapCatQQ/NapCat)

### 出站媒体安全

图片和语音在 OpenClaw 侧经过 SSRF、目录、类型和 25 MiB 大小检查后，以 Base64 发送给 NapCat；失败时不会退回未经检查的原始地址。远程媒体禁止内网地址及重定向到内网，具有读取超时。本地媒体优先遵守宿主传入的读取权限；未传入时仅允许 `mediaProxyAllowedRoots` / `voiceBasePath`。这些限制也适用于未启用媒体代理的部署。

### 1.0.15 升级说明

- 修复 OpenClaw 2026.10.5 下 NapCat 插件因 `openclaw/plugin-sdk/infra-runtime` 已移除而无法加载的问题。
- 本地媒体读取改用官方 `openclaw/plugin-sdk/file-access-runtime` 入口，继续使用相同的安全读取函数，保留目录、符号链接和大小限制；仍兼容最低支持版本 OpenClaw 2026.8.2。

### 1.0.14 升级说明

- 入站图片从文字占位符升级为原生视觉附件：消息通过签名、权限和路由检查后，安全下载顶层 `image` / `mface`，经 OpenClaw 官方 SDK 托管存储后随文本派发，支持单图及多图。
- 下载具备 SSRF 防护、超时、大小和并发限制；图片 URL 在入站日志中脱敏。失败项在消息重投时可重试，成功附件缓存失效或文件被清理后可重新下载；结构化正文中的 CQ 示例仍按文字保留。
- 每条消息最多 8 张、每张 10 MiB；动画不保证逐帧理解，不递归下载合并转发或引用消息中的图片。无需新增配置或开启媒体代理；详见下方“原生入站图片”。

### 1.0.13 升级说明

- 必须配置 `webhookSecret`，并将同一密钥填入 NapCat HTTP 客户端的 Token；这与 HTTP 服务器的出站 `token` 是两个配置项。缺失签名配置时不再接收入站事件。
- Webhook 请求体最大 1 MiB，读取超时 10 秒。支持数组、`events` 和 `data` 形式的批量事件；逐条处理，单条处理失败不会阻止后续事件，也不会要求 NapCat 重放整批。
- 本地图片和语音遵守宿主授权读取能力或显式允许目录；不再直接读取任意路径或将受阻地址交给 NapCat 重试。远程媒体禁止私网目标，拒绝非媒体和 SVG。
- 回复正文中的 CQ 码按文字显示；插件生成的引用、提及和媒体控制段仍正常工作。
- 群文件采用每次上传独立的临时目录，保留原始文件，支持同名文件并发上传。
- NapCat API 响应最大 8 MiB，响应中断和整体超时会结束任务；非法响应或缺少消息回执表示投递结果未知，不自动重发消息。调度器能够接收真实投递失败。


## 原生入站图片

通过 Webhook 签名、用户白名单、群开关/白名单、提及规则及路由检查的消息，会在派发前下载顶层 `image` / `mface` 图片。结构化 segment 为准（其中的 text 原样保留，不把 CQ 语法示例当附件）；仅没有结构化消息时解析原始 CQ，按 OneBot 规则单次解码参数（结构化 JSON 的 URL 不做重复解码）。文本和图片顺序保留，图片和触发消息的 `MessageSid` 一起派发。

实现复用 OpenClaw `openclaw/plugin-sdk/media-runtime` 的 `fetchRemoteMedia`（DNS/SSRF 安全下载）、`detectMime`（仅依据字节识别）、`saveMediaBuffer`（托管 inbound 存储）及 `buildAgentMediaPayload`。后者产生官方兼容的 `MediaPath/MediaPaths`、`MediaUrl/MediaUrls`、`MediaType/MediaTypes` 字段；路径/URL 字段均引用托管本地文件，不把 QQ 临时 URL 交给模型再下载。

- 支持 JPEG、PNG、GIF、WebP；动画是否完整可见取决于模型/宿主，不保证逐帧理解。
- 固定上限：每消息 8 张、每张 10 MiB、每次下载 10 秒（SDK 的 AbortSignal 覆盖响应头及完整响应体，不只是等待响应头）、进程内最多 4 个同时下载/存储操作。单消息串行下载以保留顺序；满载时安全降级，不建立无界队列。
- 只接受 HTTP(S)，拒绝 URL 用户名/密码、本地路径、file/data 协议；SDK 默认阻止私网、环回、元数据地址和 DNS 重绑定。为收紧重定向攻击面，当前不跟随任何重定向。
- 下载过期/失败、超限、非图片或写入失败，不丢弃消息文本；成功的其他图片仍派发，并追加带图片序号的“图片附件不可用”错误码。错误消息不包含源 URL。
- 按机器人、会话、发送者、message_id 和图片列表摘要共享进行中的处理（含缓存可读性检查）。成功附件逐张缓存：最多 256 张、成功存储后 5 分钟；busy、下载/存储失败不会缓存，重投会立即重试失败项，同时复用仍可读的成功项并保持原顺序。缓存文件被清理或不可读时只重新下载失效项。缓存仅减少重复下载，**不改变原有重复 Webhook 的消息派发语义**；进程重启、淘汰/过期后会重新下载。文件生命周期由 OpenClaw 媒体存储管理，不在回复结束时删除，以兼容排队中的模型调用。
- 入站日志及 RawBody 中的图片 CQ 只保留“[图片]”，避免保存临时 URL 凭证；无法解析的原始请求体不再写入 parse-error.log（仍记录事件及截断标记）。普通文本/文件/语音处理未扩展。
- 不新增配置；与出站 mediaProxyEnabled 无关。不递归下载合并转发/引用消息中的图片；仅有 NapCat 本地文件名、没有 HTTP(S) URL 的图片会明确降级。

本地验证：npm test 包含有签名 Webhook → 真正 dispatch context → 可读取的 SDK 托管图片测试，以及权限过滤、顺序、CQ 转义、下载失败、SSRF、重定向、响应头/响应体停滞超时、大小/数量/并发、失败/满载恢复、部分失败重试、真实缓存文件删除后并发重投以及正文/命令 CQ 文本保真测试。下载使用受控测试替身；这不等同于线上 QQ → 当前模型视觉的端到端验收。部署后仍需发送单图、多图和动画表情验证实际 QQ CDN 与所选模型；无需/不应为此关闭 SSRF 防护。
