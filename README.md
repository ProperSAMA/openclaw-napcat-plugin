# OpenClaw NapCat Plugin

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

QQ 聊天通道插件 for OpenClaw，基于 NapCat (OneBot 11) 实现。
部署完毕后，可通过 QQ 与 OpenClaw 对话、下达指令

## 功能特性

- ✅ 接收私聊和群组消息
- ✅ 支持文本消息收发
- ✅ 支持群聊/私聊 sessionKey 路由
- ✅ 支持图片等媒体发送（CQ:image）
- ✅ 支持 `action:<接口名>` 方式调用 NapCat 通用接口
- ✅ 第一批内置好友能力：好友列表、好友申请处理、好友备注、陌生人信息
- ✅ 第二批内置群管理能力：群列表、群信息、成员列表、禁言、踢人、群名片、群名
- ✅ 第三批系统/增强能力：状态、版本、最近联系人、在线状态、图片 OCR
- ✅ 第四批文件能力：私聊/群文件上传、群文件列表、文件 URL、删除群文件
- ✅ 第五批补充文件能力：移动群文件、私聊文件直链、本地文件获取、音频转码获取
- ✅ 第六批流式文件能力：兼容 `stream-action`，支持流式上传与临时文件清理
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

## 源码结构

重构后的 `src/` 目录按“入口层 + 共享模块 + 领域模块”组织，后续继续扩展接口时建议优先复用 barrel 入口：

- `src/channel.ts`：NapCat channel 入口，保留插件声明、配置接入、`sendText`、`sendMedia`
- `src/webhook.ts`：NapCat webhook 入口，保留 HTTP 入口、事件分发、兼容导出
- `src/index.ts`：共享模块 barrel，统一导出 target、transport、message format、action params、媒体上下文、日志、消息事件等公共能力
- `src/actions/index.ts`：action handler barrel，统一导出 `friend` / `group` / `request-notice` / `system` / `file` / `stream` handlers
- `src/runtime.ts`：插件运行时与当前 channel 配置的全局访问入口
- `src/ws.ts`：NapCat WebSocket transport、连接管理、心跳、`stream-action` 聚合
- `src/napcat-transport.ts`：HTTP/WS 发送、token 注入、通用 `callNapCatAction`
- `src/napcat-message-format.ts`：CQ 媒体格式化、媒体代理 URL、回复消息拼装
- `src/napcat-media-context-store.ts`：`context_*_id`、TTL、本地缓存清理
- `src/napcat-inbound-media.ts`：CQ 媒体解析、本地下载、上下文构建
- `src/napcat-message-event.ts`：入站消息主流程、session 路由、多模态上下文注入、reply dispatcher
- `src/napcat-friend-request.ts`：好友申请日志与自动处理
- `src/napcat-group-request.ts`：群申请 / 群邀请事件审计
- `src/napcat-notice-event.ts`：高价值 notice 事件审计
- `src/napcat-media-proxy.ts`：`/napcat/media` 代理处理
- `src/napcat-inbound-log.ts`：入站日志与 parse-error 日志

维护约定：

- 入口文件优先从 `src/index.ts` 或 `src/actions/index.ts` 导入，减少零散相对路径
- `runtime.ts` 与 `ws.ts` 也已经纳入 `src/index.ts` 统一导出；上层编排模块可直接经由 barrel 使用
- 叶子模块尽量直接依赖具体文件，避免从总 barrel 反向导入导致循环依赖
- 若新增 NapCat action，优先放到 `src/actions/` 下对应领域文件，再由 `src/actions/index.ts` 和 `src/napcat-action-dispatch.ts` 注册

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
      "actionTimeoutMs": 10000,
      "inboundMediaDir": "./workspace/napcat-inbound-media",
      "inboundMediaAutoCleanupEnabled": true,
      "inboundMediaTtlMs": 86400000,
      "inboundMediaCleanupMinIntervalMs": 300000,
      "streamTempAutoCleanupEnabled": true,
      "streamTempAutoCleanupMode": "safe",
      "inboundImageEnabled": true,
      "inboundImagePreferUrl": true,
      "autoApproveFriendRequests": false,
      "friendAutoRemarkTemplate": "",
      "friendRequestAllowUsers": [],
      "friendRequestLogDir": "./logs/napcat-friend-requests",
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
| `actionTimeoutMs` | number | NapCat 通用 action 的超时提示配置（当前主要用于文档约定） | `10000` |
| `agentId` | string | 可选，固定将 NapCat 会话绑定到该 OpenClaw agent（如 `main`、`ops`） | `""`（空=按默认路由） |
| `allowUsers` | string[] | 允许接收消息的 QQ 用户 ID 列表 | `[]` (接收所有) |
| `enableGroupMessages` | boolean | 是否处理群消息 | `false` |
| `groupMentionOnly` | boolean | 群消息是否需要 @ 机器人 | `true` |
| `mediaProxyEnabled` | boolean | 启用 `/napcat/media` 媒体代理（跨设备发图推荐） | `false` |
| `publicBaseUrl` | string | OpenClaw 对 NapCat 可达的地址（如 `http://127.0.0.1:18789`） | `""` |
| `mediaProxyToken` | string | 媒体代理可选访问令牌 | `""` |
| `voiceBasePath` | string | 相对语音文件名的基础目录（例如 `/tmp/napcat-voice`） | `""` |
| `enableInboundLogging` | boolean | 是否记录入站消息日志 | `true` |
| `inboundLogDir` | string | 入站消息与 notice 审计日志目录 | `"./logs/napcat-inbound"` |
| `inboundImageEnabled` | boolean | 是否解析入站 CQ:image/CQ:record 为多模态输入 | `true` |
| `inboundImagePreferUrl` | boolean | 解析图片时是否优先使用 CQ 中的 `url` 字段（否则优先 `file`） | `true` |
| `inboundMediaDir` | string | 入站媒体本地缓存目录，插件会先下载到这里再交给 OpenClaw | `"./workspace/napcat-inbound-media"` |
| `inboundMediaAutoCleanupEnabled` | boolean | 是否自动清理过期的入站媒体本地缓存 | `true` |
| `inboundMediaTtlMs` | number | 入站媒体与 `context_*_id` 的保留时长（毫秒） | `86400000` |
| `inboundMediaCleanupMinIntervalMs` | number | 两次本地缓存扫描之间的最小间隔（毫秒） | `300000` |
| `streamTempAutoCleanupEnabled` | boolean | 是否在安全条件下自动清理 NapCat 流式临时目录 | `true` |
| `streamTempAutoCleanupMode` | string | 流式临时目录自动清理模式：`off` / `safe` | `"safe"` |
| `autoApproveFriendRequests` | boolean | 是否自动同意收到的好友申请 | `false` |
| `friendAutoRemarkTemplate` | string | 自动同意好友申请时的备注模板，支持 `{userId}` / `{nickname}` / `{comment}` | `""` |
| `friendRequestAllowUsers` | string[] | 自动同意好友申请的 QQ 白名单，空数组表示不限制 | `[]` |
| `friendRequestLogDir` | string | 好友 / 群申请审计日志目录 | `"./logs/napcat-friend-requests"` |

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

### 定时任务与传输模式

- **`transport: "http"`**：发消息时每次对 NapCat 的 HTTP 端口（如 3000）发起独立请求，不依赖长连接。网关侧对 napcat 通道的健康检查也与连接状态解耦，定时任务（cron）触发时通常能稳定投递。
- **`transport: "ws-client"`**：发消息走 WebSocket，依赖 OpenClaw 到 NapCat 的 WS 长连接。网关的 health-monitor 会因“通道进程/连接停止”而反复重启 napcat 通道（日志中可见 `[napcat] [default] auto-restart attempt N/10`）。若定时任务恰好在重启窗口或 WS 未就绪时执行，可能报错或投递失败。
- **建议**：若定时任务必须稳定成功，优先使用 `transport: "http"`，并在 NapCat 侧同时启用 HTTP 服务器（如 3000）和 HTTP 客户端（指向 OpenClaw 的 `/napcat`）。若需使用 `ws-client`，可排查网关侧为何将 napcat 判为 stopped（例如 WS 断开或通道进程退出），待通道稳定后再依赖定时任务。

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

## 入站媒体识别说明

当 QQ 通过 NapCat 发送图片（`[CQ:image,...]`）、语音（`[CQ:record,...]`）或视频（`[CQ:video,...]`）时：

- 插件会在入站阶段解析 CQ 段：
  - 提取 `url` / `file`，生成图片/音频 URL 列表
  - 将纯文本中的图片 CQ 片段剥离，只保留用户正文
- 为了兼容容器环境与远程模型取图限制，插件会优先把入站图片/语音/视频下载到 OpenClaw 本地缓存目录，再通过 `MediaPath` / `MediaPaths` / `MediaType` / `MediaTypes` 交给 OpenClaw。
- 注入到上下文中的 `MediaPath` / `MediaPaths` 会优先使用工作区相对路径（例如 `./napcat-inbound-media/xxx.png`），避免把容器内绝对路径直接暴露给模型而触发本地路径访问限制。
- 解析结果会注入到 OpenClaw 上下文中，例如：
  - `MediaUrls` / `MediaUrl`
  - `ImageUrls` / `Images`
  - `AudioUrls` / `Audios`
  - `VideoUrls` / `Videos`
  - `MediaPath` / `MediaPaths`
  - `MediaType` / `MediaTypes`
  - `ImageContexts` / `AudioContexts` / `VideoContexts`
  - `MediaContexts` / `MediaContextIds`
- 上层 agent 会把这些媒体作为多模态输入交给模型，从而真正看到图片/语音，而不是只看到 `[CQ:image,...]` 这一串文本。

自动清理说明：

- 本地入站媒体缓存默认保留 `24h`，超时后会在后续入站处理或上下文读取时惰性清理。
- 仍被 `context_*_id` 引用的本地文件不会被提前删除，避免上下文命中后出现 `ENOENT`。
- 超过 TTL 后，对应 `context_image_id` / `context_audio_id` / `context_video_id` 也会一并过期，需要从新的消息上下文重新获取。

相关配置：

- `inboundImageEnabled`: 控制是否启用入站 CQ 媒体解析（默认启用）
- `inboundImagePreferUrl`: 控制在 CQ 同时提供 `url` 和 `file` 时优先使用哪一个（默认优先 `url`）
- `inboundMediaAutoCleanupEnabled`: 控制是否自动清理过期的本地缓存
- `inboundMediaTtlMs`: 控制本地缓存和 `context_*_id` 的复用窗口
- `inboundMediaCleanupMinIntervalMs`: 控制本地缓存扫描的最小间隔

## 发送消息说明

为了确保正确路由，请明确指定 `channel: "napcat"`，并使用以下目标格式：

私聊目标
- `agent:<agentId>:session:napcat:private:<QQ号>`（当前会话优先）
- `private:<QQ号>`
- `session:napcat:private:<QQ号>`

群聊目标
- `agent:<agentId>:session:napcat:group:<群号>`（当前会话优先）
- `group:<群号>`
- `session:napcat:group:<群号>`

注意：

- 若当前上下文里已经给出 `ConversationLabel` / `SessionKey`，优先直接复用 `agent:<agentId>:session:napcat:*` 这个完整会话标签。
- 纯数字 `target` 会被当作私聊用户 ID，群聊请务必加上 `group:` 或 `session:napcat:group:` 前缀。
- 不要使用旧的 `agent:<agentId>:napcat:group:<群号>` / `agent:<agentId>:napcat:private:<QQ号>` 标签，它不代表当前 NapCat 会话上下文。
- 调用 `message` 工具发送时必须传 `target`；不要只传 `groupId` 或 `userId`。

## 通用 NapCat Action 调用

为了让 OpenClaw 直接调用 NapCat 的更多接口，插件新增了统一调用面：

- `channel: "napcat"`
- `target: "action:<NapCat接口名>"`
- `text`: JSON 参数对象

示例：

```json
{
  "channel": "napcat",
  "target": "action:get_friend_list",
  "text": "{}"
}
```

```json
{
  "channel": "napcat",
  "target": "action:get_stranger_info",
  "text": "{\"user_id\":\"123456789\"}"
}
```

说明：

- `text` 必须是合法 JSON；也支持用 ```json fenced code block``` 包裹。
- 未知 action 也会透传到 NapCat，但建议优先使用已在 skill 中约定的接口。
- `sendMedia` 不支持 `action:*` 目标，action 调用只能走 `text` 参数。

### 第一批好友接口

当前已优先适配：

- `action:get_friend_list`
- `action:get_stranger_info`
- `action:set_friend_add_request`
- `action:set_friend_remark`
- `action:delete_friend`

其中：

- `set_friend_add_request` 需要 JSON：`{"flag":"<flag>","approve":true,"remark":"张三"}`
- `set_friend_remark` 需要 JSON：`{"user_id":"123456789","remark":"新备注"}`
- `get_stranger_info` 需要 JSON：`{"user_id":"123456789"}`，可选 `no_cache`

### 第二批群管理接口

当前已优先适配：

- `action:get_group_list`
- `action:get_group_info`
- `action:get_group_member_list`
- `action:set_group_ban`
- `action:set_group_kick`
- `action:set_group_card`
- `action:set_group_name`

其中：

- `get_group_info` 需要 JSON：`{"group_id":"123456789"}`，可选 `no_cache`
- `get_group_member_list` 需要 JSON：`{"group_id":"123456789"}`
- `set_group_ban` 需要 JSON：`{"group_id":"123456789","user_id":"10001","duration":1800}`
- `set_group_kick` 需要 JSON：`{"group_id":"123456789","user_id":"10001","reject_add_request":false}`
- `set_group_card` 需要 JSON：`{"group_id":"123456789","user_id":"10001","card":"新群名片"}`
- `set_group_name` 需要 JSON：`{"group_id":"123456789","group_name":"新群名"}`

建议：

- 查询类接口可直接由 agent 调用
- `set_group_ban` / `set_group_kick` / `set_group_card` / `set_group_name` 属于有副作用操作，建议由 skill 先确认参数再调用

### 第三批系统/增强接口

当前已优先适配：

- `action:get_status`
- `action:get_version_info`
- `action:get_recent_contact`
- `action:set_online_status`
- `action:ocr_image`

其中：

- `get_status` 需要 JSON：`{}`
- `get_version_info` 需要 JSON：`{}`
- `get_recent_contact` 需要 JSON：`{}`
- `set_online_status` 需要 JSON：`{"status":10}`，可选 `extStatus`、`batteryStatus`
- `ocr_image` 需要 JSON：`{"image":"<NapCat图片ID或图片标识>"}`

说明：

- `get_status` / `get_version_info` / `get_recent_contact` 属于只读查询，适合直接作为运行状态检查。
- `set_online_status` 会改变机器人 QQ 账号状态，请谨慎使用。
- `ocr_image` 依赖 NapCat 可识别的图片标识，通常更适合处理已存在于 QQ/NapCat 上下文中的图片资源。参考 [NapCat Apifox OCR 文档](https://napcat.apifox.cn/226658231e0) 和 [NapCat 接口兼容情况](https://napneko.github.io/develop/api)。

### 第四批文件接口

当前已优先适配：

- `action:upload_private_file`
- `action:upload_group_file`
- `action:get_group_root_files`
- `action:get_group_files_by_folder`
- `action:get_group_file_url`
- `action:delete_group_file`

其中：

- `upload_private_file` 需要 JSON：`{"user_id":"123456789","file":"/tmp/test.txt","name":"test.txt"}`
- `upload_group_file` 需要 JSON：`{"group_id":"123456789","file":"/tmp/test.txt","name":"test.txt"}`，可选 `folder`
- `get_group_root_files` 需要 JSON：`{"group_id":"123456789"}`
- `get_group_files_by_folder` 需要 JSON：`{"group_id":"123456789","folder_id":"/资料"}`
- `get_group_file_url` 需要 JSON：`{"group_id":"123456789","file_id":"<file_id>","busid":102}`，`busid` 视 NapCat 返回结构决定是否必传
- `delete_group_file` 需要 JSON：`{"group_id":"123456789","file_id":"<file_id>","busid":102}`，`busid` 视 NapCat 返回结构决定是否必传

说明：

- 列表/查询类接口可直接由 agent 调用。
- 上传和删除属于有副作用操作，建议由 skill 先确认目标群号、QQ 号、文件路径和 `file_id`。
- 若用户没有提供 `file_id` / `busid`，可先调用 `get_group_root_files` 或 `get_group_files_by_folder` 获取群文件元数据后再执行。

### 第五批补充文件接口

当前已优先适配：

- `action:move_group_file`
- `action:get_private_file_url`
- `action:get_file`
- `action:get_record`

其中：

- `move_group_file` 需要 JSON：`{"group_id":"123456789","file_id":"<file_id>","current_parent_directory":"/old","target_parent_directory":"/new"}`
- `get_private_file_url` 需要 JSON：`{"file_id":"<file_id>"}`
- `get_file` 需要 JSON：`{"file_id":"<file_id>"}` 或 `{"file":"<file>"}`
- `get_record` 需要 JSON：`{"file_id":"<file_id>","out_format":"mp3"}`，也可改用 `file`

说明：

- `move_group_file` 属于有副作用操作，建议先通过 `get_group_root_files` / `get_group_files_by_folder` 获取 `file_id` 和目录 ID，再确认移动目标。
- `get_private_file_url` 适合拿私聊文件直链；`get_group_file_url` 则用于群文件。
- `get_file` / `get_record` 至少需要 `file_id` 或 `file` 之一。`get_record` 适合把收到的语音转成 `mp3`、`wav` 等通用格式。

### 第六批流式文件接口

当前已优先适配：

- `action:upload_file_stream`
- `action:download_file_stream`
- `action:download_file_image_stream`
- `action:download_file_record_stream`
- `action:clean_stream_temp_file`

其中：

- `upload_file_stream` 分片阶段需要 JSON：`{"stream_id":"<stream_id>","chunk_data":"<base64>","chunk_index":0,"total_chunks":10,"file_size":12345,"expected_sha256":"<sha256>","filename":"big.bin"}`
- `upload_file_stream` 完成阶段需要 JSON：`{"stream_id":"<stream_id>","is_complete":true}`
- `download_file_stream` 需要 JSON：`{"file_id":"<file_id>"}`、`{"file":"<file>"}`，或 `{"context_video_id":"<VideoContextId>"}` / `{"context_media_id":"<MediaContextId>"}`，可选 `chunk_size`
- `download_file_image_stream` 需要 JSON：`{"file_id":"<file_id>"}`、`{"file":"<file>"}`，或 `{"context_image_id":"<ImageContextId>"}` / `{"context_media_id":"<MediaContextId>"}`，可选 `chunk_size`
- `download_file_record_stream` 需要 JSON：`{"file_id":"<file_id>"}`、`{"file":"<file>"}`，或 `{"context_audio_id":"<AudioContextId>"}` / `{"context_media_id":"<MediaContextId>"}`，可选 `chunk_size`、`out_format`
- `clean_stream_temp_file` 需要 JSON：`{}`

说明：

- 插件现已兼容 NapCat `stream-action` 多段返回：会等待同一 `echo` 的最终 `response` / `error`，并把中间分段附加到返回值中的 `stream_chunks`。
- `upload_file_stream` 适用于大文件和跨设备部署，但需要外部先准备好分片后的 base64 数据与 SHA256。
- `download_file_stream` 的官方参数是 `file` / `file_id` / `chunk_size`。插件会返回首段 `file_info`、后续 `file_chunk` 分段，以及最终 `file_complete` 汇总。
- `download_file_image_stream` 与 `download_file_stream` 类似，但插件额外支持 `context_image_id`：当图片来自当前会话的入站消息上下文时，优先用这个稳定标识，不必依赖 NapCat 内部 UUID。普通 CQ 图片文件名或原始 URL 不一定能被 `resolveDownload()` 识别。
- `download_file_record_stream` 除了普通 `file_id` / `file` 外，还支持 `context_audio_id`，可直接复用本地语音缓存；若走本地上下文快捷路径，返回的是缓存文件流，不经过 NapCat 转码临时目录。
- `download_file_stream` 还支持 `context_video_id` 与通用 `context_media_id`，适合复用当前消息中的本地视频缓存。
- `clean_stream_temp_file` 的官方行为是清空 NapCat 流式传输临时目录，不是按单个 `stream_id` 精确删除。插件现在默认启用 `safe` 模式的保守自动清理，只会在流式下载/上传成功完成且当前没有并发流式任务时自动触发；手动调用仍然可用。

建议工作流：

1. 若是当前会话刚收到的图片/语音/视频，优先从上下文中的 `ImageContexts` / `AudioContexts` / `VideoContexts` / `MediaContexts` 取稳定标识
2. 图片优先用 `{"context_image_id":"<ImageContextId>"}` 调 `action:download_file_image_stream`
3. 语音优先用 `{"context_audio_id":"<AudioContextId>"}` 调 `action:download_file_record_stream`
4. 视频优先用 `{"context_video_id":"<VideoContextId>"}` 调 `action:download_file_stream`
5. 若不是当前上下文媒体，再通过 `get_group_root_files`、`get_group_files_by_folder`、`get_file` 等方式拿稳定的 `file_id` 或 `file`
6. 消费返回中的 `stream_chunks`
7. 默认情况下，插件会在安全条件满足时自动调用 `clean_stream_temp_file`；只有需要人工兜底时，再手动调用 `action:clean_stream_temp_file`

入站媒体上下文字段：

- `ImageContextIds`: 当前消息提取到的稳定图片标识数组
- `ImageContextId`: 第一张图片的稳定标识
- `ImageContexts`: 详细数组，内含 `id`、`file`、`url`、`localPath`、`messageId`、`downloadTarget`、`downloadPayload`
- `AudioContextIds` / `AudioContextId` / `AudioContexts`: 当前消息提取到的稳定语音标识
- `VideoContextIds` / `VideoContextId` / `VideoContexts`: 当前消息提取到的稳定视频标识
- `MediaContextIds` / `MediaContextId` / `MediaContexts`: 图片/语音/视频统一视图

示例：

```json
{
  "channel": "napcat",
  "target": "action:download_file_image_stream",
  "text": "{\"context_image_id\":\"napcat-image:group:group:514572748:7613633388475457095:0\",\"chunk_size\":65536}"
}
```

### 第七批请求 / 通知接口

当前已优先适配：

- `action:set_group_add_request`
- `action:get_group_system_msg`
- `action:get_group_ignore_add_request`

其中：

- `set_group_add_request` 需要 JSON：`{"flag":"<flag>","sub_type":"add","approve":true,"reason":"欢迎加入"}`
- `get_group_system_msg` 需要 JSON：`{}`
- `get_group_ignore_add_request` 需要 JSON：`{}`

说明：

- `set_group_add_request` 用于处理群申请或群邀请；`sub_type` 当前要求显式传 `add` 或 `invite`。
- `approve=false` 时可选传 `reason` 作为拒绝说明；为兼容旧调用，也接受把 `remark` 当作 `reason` 传入。
- 推荐先调用 `get_group_system_msg` 查看待处理系统消息，再结合 webhook 记录到的 `flag` 做审批。
- 这批接口都有副作用或会影响待处理队列，建议在执行前再次确认 `flag`、`sub_type` 与目标群。

## 好友申请日志与自动处理

NapCat 上报 `post_type=request` + `request_type=friend` 时，插件会：

- 把好友申请写入 `friendRequestLogDir`
- 若 `autoApproveFriendRequests=true`，会直接调用 `set_friend_add_request`
- 若配置了 `friendRequestAllowUsers`，仅对白名单 QQ 生效

默认日志目录：

- `./logs/napcat-friend-requests/requests.log`
- `./logs/napcat-friend-requests/qq-<QQ号>.log`

## 群申请 / 群邀请日志

NapCat 上报 `post_type=request` + `request_type=group` 时，插件会：

- 把群申请和群邀请写入 `friendRequestLogDir`
- 在 `requests.log` 中保留总览，便于统一检索最近待处理项
- 同时按群和按用户拆分文件，便于审批前回看上下文

默认日志文件：

- `./logs/napcat-friend-requests/requests.log`
- `./logs/napcat-friend-requests/group-<群号>.log`
- `./logs/napcat-friend-requests/qq-<QQ号>.log`

常用字段：

- `ts`、`group_id`、`user_id`、`sub_type`、`comment`、`flag`、`status`

## Notice 事件审计

NapCat 上报 `post_type=notice` 时，插件会把事件写入 `inboundLogDir` 下的 notice 日志。

首批重点覆盖：

- `group_increase`
- `group_decrease`
- `group_recall`
- `group_ban`
- `group_admin`

默认日志文件：

- `./logs/napcat-inbound/notices.log`
- `./logs/napcat-inbound/notices/group-<群号>.log`
- `./logs/napcat-inbound/notices/qq-<QQ号>.log`

说明：

- 当前阶段以统一审计和后续工作流衔接为主，默认不会自动执行群治理动作。
- 每条记录会保留 `notice_type`、`sub_type`、`operator_id`、`message_id`、`duration` 等关键字段，便于后续 skill/agent 做审批、回溯或风控。

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
