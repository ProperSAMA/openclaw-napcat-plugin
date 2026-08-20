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

### 媒体代理（跨机器部署）

| 配置项 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `mediaProxyEnabled` | boolean | 是否开启媒体代理，解决跨机器图片/语音发送问题 | `false` |
| `publicBaseUrl` | string | OpenClaw 对 NapCat 可访问的地址 | `""` |
| `mediaProxyToken` | string | 媒体代理的访问令牌（可选） | `""` |

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

如果 OpenClaw 和 NapCat 不在同一台机器上，文字能发但图片发不出去，需要开启媒体代理：

```json
{
  "channels": {
    "napcat": {
      "url": "http://192.168.1.20:15150",
      "mediaProxyEnabled": true,
      "publicBaseUrl": "http://192.168.1.10:18789",
      "mediaProxyToken": "change-me"
    }
  }
}
```

- `publicBaseUrl` 必须是 NapCat 能访问到的地址
- 如果设置了 `mediaProxyToken`，两边请求必须带上正确 token
- 防火墙 / Docker 端口映射 / 局域网访问都要打通

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
