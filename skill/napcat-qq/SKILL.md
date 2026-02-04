---
name: napcat-qq
description: "为 openclaw 发送 QQ 消息时，强制使用 napcat 插件 API，并按照私聊/群聊规则生成与校验 sessionKey。适用于“发送QQ消息”“发群消息”“发QQ私聊”等请求。"
---

# 目标

确保 openclaw 发送 QQ 消息时只使用本插件的 API，并让 sessionKey 满足 napcat 插件要求。

# 工作流

1. 识别消息类型：私聊或群聊。
2. 校验并构造 sessionKey：
   - 私聊：`session:napcat:private:<QQ号>`
   - 群聊：`session:napcat:group:<群号>`
3. 目标写法说明（重要）：
   - 群聊优先使用 `target: group:<群号>` 或 `target: session:napcat:group:<群号>`。
   - 纯数字 `target` 会被当作私聊用户 ID，容易导致“无法获取用户信息”。
4. 调用 message 工具时必须显式指定 `channel: "napcat"`，避免多通道场景下无法路由。
4. 仅使用本插件的 API 完成发送，不要调用其他 QQ 发送途径。

# 交互规则

- 若用户未提供 QQ 号或群号，先询问并明确补全后再发送。
- 若用户提供了 sessionKey 但格式不符合规则，改写为正确格式并说明已规范化。
- 若用户含糊描述（如“发消息给他”），优先确认私聊/群聊与目标 ID。
