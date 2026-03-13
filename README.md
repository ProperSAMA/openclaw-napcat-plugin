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

## 这插件能做什么？

目前支持：

- 私聊消息收发
- 群聊消息收发
- 读取合并转发消息（`CQ:forward`）
- 按会话自动路由到 OpenClaw
- 图片发送
- 语音发送（WAV 等音频）
- 群文件上传
- 白名单控制（只允许指定 QQ 号触发）
- 入站消息日志记录

适合的场景：

- 想把 OpenClaw 接到自己的 QQ 上
- 想让 OpenClaw 在 QQ 群里工作
- 想做一个“QQ 上可直接对话”的私人工具助手

---

## 一句话理解安装流程

你需要把三件事接起来：

1. **NapCat 正常运行**
2. **OpenClaw 安装这个插件**
3. **NapCat 把消息转发给 OpenClaw**

只要这三步通了，基本就能用。

---

## 开始前，你需要准备什么

在安装前，最好先确认你已经有：

- 一个能正常运行的 **OpenClaw**
- 一个能正常运行的 **NapCat**
- 能编辑 `~/.openclaw/openclaw.json`
- 能重启 OpenClaw Gateway

如果你对 NapCat 还不熟，可以先把 NapCat 单独跑起来，确认它本身没问题，再来接 OpenClaw。

---

## 最简单上手方式（推荐先这样配）

如果你只想尽快跑通，先按这个最小方案来。

### 第 1 步：获取项目

你可以 clone 仓库，或者直接下载 ZIP。

```bash
git clone https://github.com/ProperSAMA/openclaw-napcat-plugin.git
```

记住你下载后的项目路径，比如：

```bash
/Users/yourname/Documents/openclaw-napcat-plugin
```

---

### 第 2 步：安装插件

```bash
openclaw plugins install <项目路径>
```

例如：

```bash
openclaw plugins install /Users/yourname/Documents/openclaw-napcat-plugin
```

---

### 第 3 步：放入 Skill（可选但推荐）

项目里有一个 `skill/napcat-qq`。  
把它放到 OpenClaw 的 skill 目录里，可以让 OpenClaw 更稳定地使用这个 QQ 通道。

如果你已经有自己的技能目录管理方式，也可以按你的习惯来。

---

### 第 4 步：修改 OpenClaw 配置

打开：

```bash
~/.openclaw/openclaw.json
```

加入或修改下面这段：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "http://127.0.0.1:3000",
      "streaming_mode": false,
      "enableGroupMessages": true,
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

这是一个**最小可用配置**。

它的意思是：

- 启用 `napcat` 通道
- NapCat 的 HTTP 服务地址是 `http://127.0.0.1:3000`
- `streaming_mode` 为 `true` 时会改成流式回复，每处理一步就发一条 QQ 消息
- 允许处理群消息
- 但群里必须 **@ 机器人** 才会回复

---

### 第 5 步：重启 OpenClaw Gateway

```bash
openclaw gateway restart
```

---

### 第 6 步：在 NapCat 里添加网络配置

去 NapCat 的网络配置界面，新增并启用下面两项：

#### A. Http 服务器

- Host: `0.0.0.0`
- Port: `3000`

#### B. Http 客户端

- Url: `http://127.0.0.1:18789/napcat`
- 消息格式: `String`

如果 **OpenClaw 和 NapCat 不在同一台机器上**，这里不要写 `127.0.0.1`，要改成 OpenClaw 那台机器的真实 IP。

例如：

```text
http://192.168.1.10:18789/napcat
```

---

### 第 7 步：测试

现在你可以测试：

#### 私聊测试
直接给对应 QQ 发消息。

#### 群聊测试
在群里发：

```text
@机器人 你好
```

如果配置正确，OpenClaw 就会开始处理消息。

---

## 如果你只想让特定 QQ 号能用

你可以加白名单：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "url": "http://127.0.0.1:3000",
      "allowUsers": ["123456789", "987654321"],
      "enableGroupMessages": true,
      "groupMentionOnly": true
    }
  }
}
```

这表示：

- 只有 `123456789` 和 `987654321` 这两个 QQ 号发来的消息会触发机器人
- 其他人发消息时，插件会直接忽略

如果你比较在意权限控制，建议开启。

---

## 群聊怎么工作？

群消息有 3 种常见模式：

### 模式 1：完全不处理群消息

```json
{
  "enableGroupMessages": false
}
```

适合：只想做私聊助手。

---

### 模式 2：处理群消息，但必须 @ 机器人（推荐）

```json
{
  "enableGroupMessages": true,
  "groupMentionOnly": true
}
```

适合：大多数群聊场景。  
这样不会因为群里有人聊天就一直触发机器人。

---

### 模式 3：处理所有群消息（一般不推荐）

```json
{
  "enableGroupMessages": true,
  "groupMentionOnly": false
}
```

适合：你非常确定自己需要“全群监听”。  
否则容易太吵，也更容易误触发。

---

## 发消息时，目标怎么写？

如果你要让 OpenClaw 主动往 QQ 发消息，最好明确写目标格式。

### 私聊目标

可以写：

- `private:<QQ号>`
- `session:napcat:private:<QQ号>`

例如：

- `private:123456789`
- `session:napcat:private:123456789`

### 群聊目标

可以写：

- `group:<群号>`
- `session:napcat:group:<群号>`

例如：

- `group:123456789`
- `session:napcat:group:123456789`

### 一个容易踩坑的点

如果你只写纯数字，比如：

```text
123456789
```

插件会默认把它当成 **私聊 QQ 号**。  
所以如果你要发到群，**一定要加 `group:` 前缀**。

---

## 图片和语音怎么发？

### 图片
插件支持把图片当作 QQ 图片消息发送。

### 语音
如果媒体链接是这些后缀之一，会自动按语音消息发送：

- `.wav`
- `.mp3`
- `.amr`
- `.silk`
- `.ogg`
- `.m4a`
- `.flac`
- `.aac`

---

### `voiceBasePath` 是干什么的？

如果你传的是相对文件名，比如：

```text
test.wav
```

插件会去拼接：

```text
<voiceBasePath>/test.wav
```

例如：

```json
{
  "channels": {
    "napcat": {
      "voiceBasePath": "/tmp/napcat-voice"
    }
  }
}
```

那么 `test.wav` 会被解释成：

```text
/tmp/napcat-voice/test.wav
```

如果你经常发本地语音，这个配置会很方便。

---

## OpenClaw 和 NapCat 不在同一台机器上怎么办？

这种情况最常见的问题是：

**文字能发，图片发不出去。**

因为文字可以直接通过接口发送，但图片/语音常常需要 NapCat 去“拿文件”或“拉链接”。

这时建议开启 **媒体代理**。

### 推荐配置

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

意思是：

- NapCat 在 `192.168.1.20:3000`
- OpenClaw 对 NapCat 可访问的地址是 `192.168.1.10:18789`
- 插件会把媒体地址改写成 `http://192.168.1.10:18789/napcat/media?...`
- NapCat 再去这个地址拿图片/语音

### 你要注意

- `publicBaseUrl` 必须是 **NapCat 那台机器真的能访问到的地址**
- 如果设置了 `mediaProxyToken`，两边的请求必须带上正确 token
- 防火墙 / Docker 端口映射 / 局域网访问都要打通

如果你是跨机器部署，建议优先看这里。

---

## 群文件上传怎么用？

这个插件不只是能发图片，还支持把本地文件上传到 QQ 群文件。

比如：

- PDF
- 压缩包
- 文档
- 其他本地文件

### 基本用法

当满足下面两个条件时，插件会自动按“群文件上传”处理：

1. 目标是群：`group:<群号>`
2. 你传的是**本地文件路径**

例如：

```json
{
  "action": "send",
  "channel": "napcat",
  "target": "group:123456789",
  "message": "这是本次日报文件",
  "filePath": "/tmp/daily-report.pdf"
}
```

---

### Docker 部署时要特别注意

如果 NapCat 在 Docker 容器里，而文件在宿主机上，NapCat 默认是**看不到宿主机文件路径**的。

所以你需要提供一个“宿主机目录 ↔ 容器目录”的映射。

常见做法有两种：

### 方案 A：直接使用已挂载路径

如果某个宿主机目录本来就已经挂载进 NapCat 容器，可以配置：

- `groupFileHostPrefix`
- `groupFileContainerPrefix`

例如：

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

这样插件会把宿主机路径自动换算成容器内路径。

---

### 方案 B：使用暂存目录（更通用）

如果原文件不在挂载目录里，可以让插件先复制到一个“上传暂存目录”，再让 NapCat 从容器内对应目录读取。

配置示例：

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

插件会：

1. 把文件复制到宿主机暂存目录
2. 告诉 NapCat 去读取容器内对应路径
3. 上传完成后自动清理暂存文件

这个方案对 Docker 用户通常最省心。

---

### 额外可选项：群文件默认目录

```json
{
  "channels": {
    "napcat": {
      "groupFileFolder": ""
    }
  }
}
```

它对应 NapCat 的 `folder` 参数。  
如果你希望上传进群文件的某个固定目录，可以在这里设置。

---

## 日志功能有什么用？

插件支持把收到的消息写入日志，方便你排查问题。

默认是开启的：

```json
{
  "enableInboundLogging": true,
  "inboundLogDir": "./logs/napcat-inbound"
}
```

日志会按用户或群分别记录。  
这对下面这些情况特别有帮助：

- 机器人为什么没回复？
- 是不是消息根本没进来？
- NapCat 发过来的原始内容到底长什么样？

如果你在排查群消息、@ 识别、白名单、解析失败之类的问题，这个日志非常有价值。

---

## 按昵称或备注找 QQ / 群

issue #3 对应的改动已经包含在仓库里：现在提供了一个简单的联系人搜索脚本，适合配合 `skill/napcat-qq` 一起用。

脚本路径：

```bash
skill/napcat-qq/scripts/qq-contact-search.js
```

用法：

```bash
node skill/napcat-qq/scripts/qq-contact-search.js 小明
node skill/napcat-qq/scripts/qq-contact-search.js 测试群 group
node skill/napcat-qq/scripts/qq-contact-search.js 老王 private
```

说明：

- 第一个参数是关键词
- 第二个参数可选：`private` / `group` / `all`
- 默认会去 NapCat 的 `get_friend_list` / `get_group_list` 做简单模糊匹配
- 可通过环境变量覆盖连接信息：
  - `NAPCAT_URL`
  - `NAPCAT_TOKEN`

返回结果是 JSON，里面的 `candidates` 会列出匹配到的联系人或群，供 skill 再决定是直接发送、让用户选号，还是继续追问。

---

## 完整配置示例

如果你想一次把常用项都配好，可以参考下面这份：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "agentId": "main",
      "url": "http://127.0.0.1:3000",
      "allowUsers": ["123456789", "987654321"],
      "enableGroupMessages": true,
      "groupMentionOnly": true,
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

## 配置项说明（按人话解释）

下面是主要配置项的作用。

| 配置项 | 类型 | 这是干什么的 | 默认值 |
|---|---|---|---|
| `url` | string | NapCat 的 HTTP 服务地址 | `http://127.0.0.1:3000` |
| `agentId` | string | 固定把消息交给哪个 OpenClaw agent 处理 | `""` |
| `allowUsers` | string[] | 只允许这些 QQ 号触发机器人；空数组表示不过滤 | `[]` |
| `enableGroupMessages` | boolean | 是否处理群消息 | `false` |
| `streaming_mode` | boolean | 是否启用流式传输模式；开启后会按处理步骤连续发送 QQ 消息 | `false` |
| `groupMentionOnly` | boolean | 群里是否必须 @ 机器人才处理 | `true` |
| `mediaProxyEnabled` | boolean | 是否开启媒体代理，解决跨机器图片/语音发送问题 | `false` |
| `publicBaseUrl` | string | OpenClaw 对 NapCat 可访问的地址 | `""` |
| `mediaProxyToken` | string | 媒体代理的访问令牌（可选） | `""` |
| `voiceBasePath` | string | 相对语音文件名的基础目录 | `""` |
| `groupFileFolder` | string | 群文件默认上传目录 | `""` |
| `groupFileHostPrefix` | string | 宿主机上已挂载进容器的目录前缀 | `""` |
| `groupFileContainerPrefix` | string | 上面那个目录在容器里的对应路径 | `""` |
| `groupFileStageHostDir` | string | 宿主机上的上传暂存目录 | `""` |
| `groupFileStageContainerDir` | string | 上面暂存目录在容器里的对应路径 | `""` |
| `enableInboundLogging` | boolean | 是否记录收到的消息日志 | `true` |
| `inboundLogDir` | string | 入站日志目录 | `./logs/napcat-inbound` |

---

## 常见问题

### 1. 私聊能用，群里没反应
先检查：

- `enableGroupMessages` 有没有设成 `true`
- `groupMentionOnly` 是否开启
- 你在群里有没有真的 @ 到机器人
- `allowUsers` 有没有把发消息的人拦掉

---

### 2. 消息到了 NapCat，但 OpenClaw 没回复
先检查：

- NapCat 的 Http 客户端 URL 是否正确
- OpenClaw Gateway 是否正在运行
- 插件是否真的安装并启用
- 查看 `inboundLogDir` 里的日志，看消息有没有进入插件

---

### 3. 文字能发，图片发不出去
大概率是下面这些问题：

- OpenClaw 和 NapCat 不在同一台机器上
- `mediaProxyEnabled` 没开
- `publicBaseUrl` 填错了
- NapCat 根本访问不到 OpenClaw 提供的媒体地址

---

### 4. 群文件上传失败
大概率是路径问题：

- 你传的不是本地文件路径
- NapCat 容器看不到这个文件
- `groupFileHostPrefix / groupFileContainerPrefix` 没配置好
- 或者 `groupFileStageHostDir / groupFileStageContainerDir` 没配置好

如果你是 Docker 部署，这一条最容易踩坑。

---

### 5. 纯数字 target 发错地方了
如果你只写纯数字目标，插件会默认按**私聊**处理。  
要发群消息，请明确写：

```text
group:<群号>
```

---

## 项目结构（给需要看代码的人）

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
            └── qq-contact-search.js
```

---

## License

MIT License

---

## 致谢

- [OpenClaw](https://openclaw.ai)
- [NapCat](https://github.com/NapCatQQ/NapCat)
