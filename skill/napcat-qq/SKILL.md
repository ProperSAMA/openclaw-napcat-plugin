---
name: napcat-qq
description: "为 openclaw 发送 QQ 消息（含图片/语音等媒体）时，强制使用 napcat 插件 API，并按照私聊/群聊规则生成与校验 sessionKey。适用于“发送QQ消息”“发群消息”“发QQ私聊”“发QQ图片”“发QQ语音”等请求。"
---

# 目标

确保 openclaw 发送 QQ 消息（文本与媒体）时只使用本插件的 API，并让 sessionKey 满足 napcat 插件要求。

# 工作流

1. 识别消息类型：私聊或群聊。
2. 校验并构造 sessionKey：
   - 私聊：`session:napcat:private:<QQ号>`
   - 群聊：`session:napcat:group:<群号>`
3. 目标写法说明（重要）：
   - 群聊优先使用 `target: group:<群号>` 或 `target: session:napcat:group:<群号>`。
   - 纯数字 `target` 会被当作私聊用户 ID，容易导致“无法获取用户信息”。
4. 调用 message 工具时必须显式指定 `channel: "napcat"`，避免多通道场景下无法路由。
5. 媒体发送规则：
   - 发送图片/媒体时，使用 `message` 工具并传 `mediaUrl`。
   - 可选传 `text` 作为媒体说明（caption）。
   - 语音可直接传 `.wav` 等音频 URL/路径到 `mediaUrl`，插件会按语音消息发送。
   - `mediaUrl` 需为 NapCat 可访问地址（通常是 `http/https` 局域网可达 URL）。

6. 语音生成与情绪策略（推荐约定，便于一致体验）：
   - 默认情绪策略：根据消息文本内容自动检测情绪/语气（由上游 TTS 侧实现）。
   - 显式覆盖规则：若用户明确指定情绪/语气（如“温柔/严肃/开心/激动”等），则覆盖自动检测结果。
   - 实践建议：将“默认音色/声线（voice profile）”作为**本地环境偏好**维护（见 `TOOLS.md`），避免在可分享的 skill 中绑定特定音色或语料路径。

7. 仅使用本插件的 API 完成发送，不要调用其他 QQ 发送途径。

# 交互规则

- 若用户未提供 QQ 号或群号，先询问并明确补全后再发送。
- 若用户提供了 sessionKey 但格式不符合规则，改写为正确格式并说明已规范化。
- 若用户含糊描述（如“发消息给他”），优先确认私聊/群聊与目标 ID。

# 入站日志读取（排查/取证）

当用户要求“查看收到的消息”“排查某个 QQ/群的消息”时，按下面步骤执行：

1. 先确认日志目录配置：
   - 默认目录：`./logs/napcat-inbound`
   - 若插件配置了 `channels.napcat.inboundLogDir`，优先使用该目录
2. 根据会话类型选择日志文件：
   - 私聊：`qq-<QQ号>.log`
   - 群聊：`group-<群号>.log`
3. 日志为 JSON Lines（一行一条消息），常用字段：
   - `ts`、`message_type`、`user_id`、`group_id`、`message_id`、`raw_message`、`sender`
4. 读取日志时优先给出最近消息，再按用户要求扩展范围：
   - 例如先看最后 50 条，再按关键词/时间过滤
5. 重要行为约束：
   - 即使消息不在白名单中，日志里也可能有记录（因为是“先记录后过滤”）
   - 仅把日志用于排查与上下文理解，不要绕过白名单去触发自动处理
