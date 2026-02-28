# Codes — 飞书 × Claude Code Bridge

通过飞书机器人操控服务器上的 Claude Code，让 AI 编程助手随时在线。

## 架构

```
飞书用户 ──WebSocket──▶ bridge.mjs ──stdin/stdout──▶ Claude Code CLI
                         │                              │
                    ProjectManager                 ClaudeProcess
                    (多项目管理)                  (stream-json 协议)
```

- **bridge.mjs** — 单 Node.js 进程，同时服务多个飞书 bot + 多个 Claude Code 子进程
- **ClaudeProcess** — 通过 `stream-json` 协议与 Claude CLI 通信，支持会话持久化和自动重启
- **ProjectManager** — 管理多项目生命周期，每个项目独立的 Claude 实例和飞书 bot

## 前置要求

- **Node.js** 18+（推荐 22）
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **飞书自建应用** — 需要 App ID + App Secret（详见下方配置步骤）

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/bigbrother666sh/codes.git
cd codes/bridge
npm install
```

### 2. 创建配置文件

```bash
mkdir -p ~/.codes/secrets
cp bridge.example.json ~/.codes/bridge.json
```

编辑 `~/.codes/bridge.json`：

```json
{
  "projects": {
    "myapp": {
      "path": "/home/user/projects/myapp",
      "feishu": {
        "appId": "cli_xxx",
        "appSecretPath": "~/.codes/secrets/myapp_secret"
      }
    }
  },
  "claudePath": "claude",
  "debug": false
}
```

将飞书 App Secret 写入 secret 文件：

```bash
echo -n "your-app-secret" > ~/.codes/secrets/myapp_secret
chmod 600 ~/.codes/secrets/myapp_secret
```

### 3. 启动

```bash
node bridge.mjs
```

## 配置说明

### bridge.json 字段

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `projects` | 项目配置 map（alias → {path, feishu}） | 必填 |
| `projects.*.path` | 项目代码仓路径 | 必填 |
| `projects.*.feishu.appId` | 飞书 App ID | 必填 |
| `projects.*.feishu.appSecretPath` | Secret 文件路径 | 必填 |
| `thinkingThresholdMs` | thinking 状态提示阈值（ms） | 2500 |
| `claudePath` | Claude CLI 路径 | `"claude"` |
| `debug` | 调试模式 | `false` |

### .env 调优（可选）

参见 `bridge/.env.example`。可通过环境变量覆盖 bridge.json 中的值：

```bash
FEISHU_THINKING_THRESHOLD_MS=2500    # thinking 状态提示阈值
FEISHU_BRIDGE_DEBUG=1                # 调试模式
FEISHU_BRIDGE_MAX_LOCAL_FILE_MB=15   # 本地文件大小限制
FEISHU_BRIDGE_MAX_INBOUND_IMAGE_MB=12  # 入站图片大小限制
FEISHU_BRIDGE_MAX_INBOUND_FILE_MB=40   # 入站文件大小限制
```

### 飞书自建应用创建步骤

1. 前往 [飞书开放平台](https://open.feishu.cn/app) → 创建自建应用
2. 在「权限管理」中添加：
   - `im:message` — 接收消息
   - `im:message:send_as_bot` — 以机器人身份发送消息
   - `im:resource` — 读取资源（图片/文件）
3. 在「事件与回调」中启用 **WebSocket 模式**（长连接，无需公网 IP）
4. 记录 App ID 和 App Secret
5. 发布应用版本

## 飞书命令

在飞书中向 bot 发送以下命令：

| 命令 | 说明 |
|------|------|
| `/start [alias\|all]` | 启动项目的 Claude Code |
| `/stop [alias\|all]` | 停止项目的 Claude Code |
| `/status` | 查看所有项目状态 |
| `/help` | 显示帮助 |

普通消息会直接发送给对应项目的 Claude Code 处理。

## 服务���部署

### 一键部署（Ubuntu 24.04）

```bash
curl -fsSL https://raw.githubusercontent.com/bigbrother666sh/codes/main/deploy.sh | bash
```

脚本会自动安装 Node.js、Claude Code CLI，引导配置飞书凭据，并创建 systemd 服务。

### 手动部署

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 3. 克隆并安装
git clone https://github.com/bigbrother666sh/codes.git ~/codes
cd ~/codes/bridge && npm install

# 4. 配置（参见上方「快速开始」）

# 5. 创建 systemd 服务
node setup-service.mjs
systemctl --user daemon-reload
systemctl --user enable codes-feishu-bridge
systemctl --user start codes-feishu-bridge
```

### 服务管理

```bash
# 查看状态
systemctl --user status codes-feishu-bridge

# 查看日志
journalctl --user -u codes-feishu-bridge -f

# 重启
systemctl --user restart codes-feishu-bridge
```

## 故障排查

| 症状 | 排查方法 |
|------|----------|
| bridge 启动后无反应 | 检查 `~/.codes/bridge.json` 格式，确认 secret 文件存在 |
| 飞书消息无响应 | 检查飞书应用权限，确认 WebSocket 模式已启用 |
| Claude 报错 | 确认 `claude --version` 可运行，检查 `~/.claude/settings.json` 配置 |
| 进程重启后会话丢失 | 正常行为——bridge 会自动以 `--resume` 恢复上次会话 |
| 多项目配置不生效 | 确认每个项目的 `feishu.appId` 不同，每个 bot 对应一个项目 |

## 自测

```bash
node bridge/bridge.mjs --selftest
```

验证配置加载和基本功能，不会连接飞书。

## License

MIT
