# OpenClaw NapCat Plugin

[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue.svg)](https://openclaw.ai)

QQ 聊天通道插件 for OpenClaw，基于 NapCat (OneBot 11) 实现。
部署完毕后，可通过 QQ 与 OpenClaw 对话、下达指令

## 功能特性

- ✅ 接收私聊和群组消息
- ✅ 支持文本消息收发
- ✅ 可配置的接收用户白名单
- ✅ 完整的消息路由和会话管理
- ✅ 与 OpenClaw 无缝集成

## 安装方法

暂未上架至 ClawdHub，请克隆插件仓库到 OpenClaw 扩展目录

```bash
git clone https://github.com/ProperSAMA/openclaw-napcat-plugin.git /opt/homebrew/lib/node_modules/openclaw/extensions/napcat
```

## 配置方法

在 `~/.openclaw/openclaw.json` 中添加或修改 `channels.napcat` 配置：

```json
{
  "channels": {
    "napcat": {
      "url": "http://127.0.0.1:4000",
      "allowUsers": ["你的QQ号"]
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
| `url` | string | NapCat HTTP 服务地址 | `http://127.0.0.1:4000` |
| `allowUsers` | string[] | 允许接收消息的 QQ 用户 ID 列表 | `[]` (接收所有) |
| `enableGroupMessages` | boolean | 是否处理群消息 | `false` |
| `groupMentionOnly` | boolean | 群消息是否需要 @ 机器人 | `true` |

#### 群消息配置示例

```json
{
  "channels": {
    "napcat": {
      "url": "http://127.0.0.1:4000",
      "allowUsers": ["你的QQ号"],
      "enableGroupMessages": true,
      "groupMentionOnly": true
    }
  }
}
```

**群消息说明：**
- `enableGroupMessages: false`（默认）：完全忽略群消息
- `enableGroupMessages: true, groupMentionOnly: true`：只有 @ 机器人时才处理
- `enableGroupMessages: true, groupMentionOnly: false`：处理所有群消息（不推荐）

## NapCat 配置

在 NapCat 网络配置界面新建以下网络配置并启用：

Http 服务器
- Host: 0.0.0.0
- Port: 3000

Http 客户端
- Url: `http://127.0.0.1:18789/napcat`
- 消息格式: String

如果 OpenClaw 运行在不同的机器上，请在 Http 客户端中使用实际 IP 地址。

### 查看日志

```bash
# 查看 OpenClaw 日志
tail -f /tmp/openclaw/openclaw-*.log | grep NapCat
```

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
│   └── webhook.ts        # HTTP 处理器（接收消息）
```

## 许可证

MIT License

## 致谢

- [OpenClaw](https://openclaw.ai)
- [NapCat](https://github.com/NapCatQQ/NapCat)
