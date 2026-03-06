---
name: napcat-qq
description: "为 openclaw 处理 QQ 消息与 NapCat 结构化接口调用时，强制使用 napcat 插件 API，并按照消息 target / action target 规则生成参数。适用于“发送QQ消息”“查看好友列表”“处理好友申请”“查看陌生人信息”“修改好友备注”“查看群列表”“查询群成员”“禁言/踢人/改群名片”“查看状态/OCR/最近会话”“上传/查询群文件/获取文件直链”“流式上传/下载文件”“流式下载图片/语音”等请求。"
---

# 目标

确保 openclaw 处理 QQ 消息与 NapCat 结构化接口调用时只使用本插件的 API，并让 `target` 与 JSON 参数满足 napcat 插件要求。

# 工作流

1. 先识别当前请求属于哪一类：
   - 普通私聊消息
   - 普通群消息
   - NapCat 结构化 action 调用（好友列表、陌生人资料、处理好友申请、设置备注、群管理、系统/增强接口、文件接口等）
2. 若是消息发送，再校验并构造 sessionKey：
   - 私聊：`session:napcat:private:<QQ号>`
   - 群聊：`session:napcat:group:<群号>`
3. 目标写法说明（重要）：
   - 群聊优先使用 `target: group:<群号>` 或 `target: session:napcat:group:<群号>`。
   - 纯数字 `target` 会被当作私聊用户 ID，容易导致“无法获取用户信息”。
   - 结构化 action 调用统一使用：`target: action:<NapCat接口名>`
4. 调用 `message` 工具时必须显式指定 `channel: "napcat"`，避免多通道场景下无法路由。
5. 若 `target` 以 `action:` 开头：
   - `text` 必须传合法 JSON 对象参数。
   - 可使用 ```json fenced code block```，插件会自动去掉代码块外壳。
   - 没有参数时传 `{}`。
6. 第一批好友相关 action 优先使用：
   - `action:get_friend_list`，`text: {}`
   - `action:get_stranger_info`，`text: {"user_id":"123456"}`
   - `action:set_friend_add_request`，`text: {"flag":"<flag>","approve":true,"remark":"张三"}`
   - `action:set_friend_remark`，`text: {"user_id":"123456","remark":"新备注"}`
   - `action:delete_friend`，仅在用户明确要求删除好友时才使用
7. 第二批群管理 action 优先使用：
   - `action:get_group_list`，`text: {}`
   - `action:get_group_info`，`text: {"group_id":"123456789"}`
   - `action:get_group_member_list`，`text: {"group_id":"123456789"}`
   - `action:set_group_ban`，`text: {"group_id":"123456789","user_id":"10001","duration":1800}`
   - `action:set_group_kick`，`text: {"group_id":"123456789","user_id":"10001","reject_add_request":false}`
   - `action:set_group_card`，`text: {"group_id":"123456789","user_id":"10001","card":"新群名片"}`
   - `action:set_group_name`，`text: {"group_id":"123456789","group_name":"新群名"}`
8. 群管理约束：
   - “查看群列表 / 群信息 / 群成员列表”优先走 `action:*`，不要发消息去问群里的人。
   - “禁言 / 踢人 / 改群名片 / 改群名”属于有副作用操作，执行前必须确认群号和目标用户。
   - 若用户只给了群名称没给群号，先查询群列表再让用户确认。
   - `set_group_ban.duration` 单位是秒；若用户只说“禁言一下”，默认不要擅自执行，先确认时长。
9. 第三批系统/增强 action 优先使用：
   - `action:get_status`，`text: {}`
   - `action:get_version_info`，`text: {}`
   - `action:get_recent_contact`，`text: {}`
   - `action:set_online_status`，`text: {"status":10}`，可选 `extStatus`、`batteryStatus`
   - `action:ocr_image`，`text: {"image":"<NapCat图片ID或图片标识>"}`
10. 系统/增强约束：
   - `get_status`、`get_version_info`、`get_recent_contact` 属于只读查询，优先直接调用。
   - `set_online_status` 会改变当前 QQ 在线状态，执行前应确认用户确实要修改账号状态。
   - `ocr_image` 依赖 NapCat 可识别的图片标识；若用户只有普通图片 URL，不要假设一定可直接 OCR，必要时先确认图片来源。
11. 第四批文件接口 action 优先使用：
   - `action:upload_private_file`，`text: {"user_id":"123456","file":"/tmp/test.txt","name":"test.txt"}`
   - `action:upload_group_file`，`text: {"group_id":"123456789","file":"/tmp/test.txt","name":"test.txt"}`
   - `action:get_group_root_files`，`text: {"group_id":"123456789"}`
   - `action:get_group_files_by_folder`，`text: {"group_id":"123456789","folder_id":"/资料"}`
   - `action:get_group_file_url`，`text: {"group_id":"123456789","file_id":"<file_id>","busid":102}`
   - `action:delete_group_file`，`text: {"group_id":"123456789","file_id":"<file_id>","busid":102}`
12. 第五批补充文件接口 action 优先使用：
   - `action:move_group_file`，`text: {"group_id":"123456789","file_id":"<file_id>","current_parent_directory":"/old","target_parent_directory":"/new"}`
   - `action:get_private_file_url`，`text: {"file_id":"<file_id>"}`
   - `action:get_file`，`text: {"file_id":"<file_id>"}` 或 `{"file":"<file>"}`
   - `action:get_record`，`text: {"file_id":"<file_id>","out_format":"mp3"}`
13. 第六批流式文件接口 action 优先使用：
   - `action:upload_file_stream`，分片上传时传 `stream_id`、`chunk_data`、`chunk_index`、`total_chunks`、`file_size`、`expected_sha256`、`filename`
   - `action:upload_file_stream`，完成阶段传 `{"stream_id":"<stream_id>","is_complete":true}`
   - `action:download_file_stream`，传 `{"file_id":"<file_id>"}` 或 `{"file":"<file>"}`，可选 `chunk_size`
   - `action:download_file_image_stream`，优先传 `{"context_image_id":"<ImageContextId>"}`，也支持 `{"file_id":"<file_id>"}` 或 `{"file":"<file>"}`，可选 `chunk_size`
   - `action:download_file_record_stream`，传 `{"file_id":"<file_id>"}` 或 `{"file":"<file>"}`，可选 `chunk_size`、`out_format`
   - `action:clean_stream_temp_file`，传 `{}`
14. 文件接口约束：
   - 上传文件前，先确认 OpenClaw 所在环境能访问 `file` 指向的本地路径或 URL。
   - `get_group_root_files` / `get_group_files_by_folder` 属于查询类，可直接调用。
   - `upload_private_file` / `upload_group_file` / `delete_group_file` / `move_group_file` 属于有副作用操作，执行前应确认目标用户、群号、文件路径、目录或文件 ID。
   - `get_group_file_url`、`delete_group_file` 通常需要 `file_id`，部分场景还需要 `busid`；若用户未提供，先通过列表接口拿到元数据再继续。
   - `get_file` / `get_record` 至少需要 `file_id` 或 `file` 之一；不要传空对象。
   - `upload_file_stream` 适合大文件或跨设备部署，但调用前需要准备好分片后的 base64 数据与 SHA256，不适合让模型临时编造参数。
   - `download_file_stream` 的官方参数是 `file` / `file_id` / `chunk_size`；优先先通过 `get_group_root_files`、`get_group_files_by_folder`、`get_file` 等接口拿到稳定文件标识再下载。
   - `download_file_image_stream` 会在 `file_info` 中额外返回图片信息；若当前消息上下文里有 `ImageContextIds` / `ImageContexts`，优先用其中的 `context_image_id`，不要默认把 CQ 图片文件名或原始 URL 当成稳定标识。
   - `download_file_record_stream` 支持 `out_format` 转换；常用值包括 `mp3`、`wav`、`ogg`、`m4a`、`flac`。
   - `clean_stream_temp_file` 官方行为是清空 NapCat 流式传输临时目录，不是按 `stream_id` 精确删除；执行前要知道它会影响当前 NapCat 临时文件。
   - 当前插件已兼容 NapCat `stream-action` 多段响应；若需要调用未封装的下载流接口，可继续使用通用 `action:<接口名>` 方式。
15. 媒体发送规则：
   - 发送图片/媒体时，使用 `message` 工具并传 `mediaUrl`。
   - 可选传 `text` 作为媒体说明（caption）。
   - 语音可直接传 `.wav` 等音频 URL/路径到 `mediaUrl`，插件会按语音消息发送。
   - `mediaUrl` 需为 NapCat 可访问地址（通常是 `http/https` 局域网可达 URL）。

16. 语音生成与情绪策略（推荐约定，便于一致体验）：
   - 默认情绪策略：根据消息文本内容自动检测情绪/语气（由上游 TTS 侧实现）。
   - 显式覆盖规则：若用户明确指定情绪/语气（如“温柔/严肃/开心/激动”等），则覆盖自动检测结果。
   - 实践建议：将“默认音色/声线（voice profile）”作为**本地环境偏好**维护（见 `TOOLS.md`），避免在可分享的 skill 中绑定特定音色或语料路径。

17. 仅使用本插件的 API 完成发送和 NapCat 接口调用，不要调用其他 QQ 发送途径。

# 交互规则

- 若用户未提供 QQ 号或群号，先询问并明确补全后再发送。
- 若用户提供了 sessionKey 但格式不符合规则，改写为正确格式并说明已规范化。
- 若用户含糊描述（如“发消息给他”），优先确认私聊/群聊与目标 ID。
- 若用户要求“查看好友列表/陌生人信息/处理好友申请/设置好友备注”，优先改写为 `action:*` 调用，而不是普通消息发送。
- 若用户要求“同意好友申请”但没有 `flag`，先读取好友申请日志，再取最近待处理记录的 `flag`。
- 若用户要求“删除好友”，先再次确认目标 QQ 号，避免误删。
- 若用户要求“查看群列表/群信息/群成员列表/禁言/踢人/改群名片/改群名”，优先改写为对应 `action:*` 调用。
- 若涉及群管理副作用操作，必须在调用前确认 `group_id` 与 `user_id`。
- 若用户要求“查看 NapCat 状态/版本/最近联系人”，优先使用 `get_status`、`get_version_info`、`get_recent_contact`。
- 若用户要求“修改在线状态”，先确认目标状态码或状态含义，再调用 `set_online_status`。
- 若用户要求“上传文件 / 查看群文件列表 / 获取群文件下载地址 / 删除群文件”，优先使用文件类 `action:*` 调用。
- 若用户只给了群名称没给群号，先查群列表或向用户确认，不要直接上传或删除群文件。
- 若涉及 `delete_group_file` 或上传类操作，必须在调用前确认关键参数，避免误删或误投递。
- 若用户要求“移动群文件 / 获取私聊文件直链 / 下载文件到本地 / 转音频格式”，优先使用 `move_group_file`、`get_private_file_url`、`get_file`、`get_record`。
- 若用户要求“大文件跨设备上传”或明确提到 Stream API，优先使用 `upload_file_stream`；若缺少 `stream_id`、分片 base64、SHA256 等必要参数，先让调用方准备，不要臆造。
- 若用户要求“流式下载文件”，优先使用 `download_file_stream`；若用户随后要求清理 NapCat 临时文件，再调用 `clean_stream_temp_file`。
- 若用户要求“流式下载图片/语音”，优先使用 `download_file_image_stream` 或 `download_file_record_stream`；若是语音转码，再补 `out_format`。
- 若当前上下文里已经有 `ImageContexts`，优先直接取其中的 `downloadPayload` 或 `context_image_id` 来调用 `download_file_image_stream`。

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

# 好友申请日志读取

当用户要求“查看最近好友申请”“同意最新好友申请”“排查某个 QQ 的好友申请”时，按下面步骤执行：

1. 先确认好友申请日志目录配置：
   - 默认目录：`./logs/napcat-friend-requests`
   - 若插件配置了 `channels.napcat.friendRequestLogDir`，优先使用该目录
2. 常用日志文件：
   - 汇总文件：`requests.log`
   - 单用户文件：`qq-<QQ号>.log`
3. 日志为 JSON Lines（一行一条记录），常用字段：
   - `ts`、`user_id`、`comment`、`flag`、`status`、`remark`
4. 手动处理好友申请时，优先选择最近一条 `status` 为 `pending` 或 `pending_blocked_by_allowlist` 的记录。
