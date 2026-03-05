# Codes — 打造你专属的 7*24 小时云端开发牛马（基于 claude code）

简单说，就是把 claude code 装在云服务器上，然后接入飞书。这样你就可以让它 7*24 为你开发了，因为 claude code 配合顶级的大模型开发能力已经足够强大（基本强于 985 研究生），所以就算你不懂开发也没问题，你就是老板，通过飞书下达指令，不管跟他讨论实现方案，还是让它给你出开发计划，抑或最终的开发实现、部署上线……你只需要用手机、飞书对话……懂不懂技术都没所谓。

<img src="docs/codes.png" alt="codes running demo" style="width: 100%;"/>

即便你是编程老手，其实用这个模式也很有价值，你可以从电脑前彻底解放，随时随地……

# 🌟 与 claude code 原版的 RC（remote control）功能相比

🚀【2026.3.5】新增：延迟消息（计划消息），`/小时-分钟 “要延迟发送的消息”` （xx 小时 xxx 分钟后，内容发给 claude code）

- 不需要 max/pro 订阅；
- 因为不需要订阅，因此可以用国内的第三方代理方案，也可以直接用 minimax 或者 kimi、glm、qwen 等 coding 套餐；
- 省不省钱的先不说，至少网络环境和账号这些麻烦不会存在了……

顺便推荐一下，[Noin.ai](https://noin.ai/) 量大盘稳

至于云端服务器，2C4G 足够了，腾讯云首单一年 79……当然因为本项目不需要公网 IP，所以你搞台二手电脑装个 ubuntu 扔家里或者办公室也是可以的……硬件几乎零成本。

**🌹 致敬：飞书连接桥方案来自：https://github.com/AlexAnys/feishu-openclaw**

**🎯 来自 https://github.com/affaan-m/everything-claude-code 的 claude code 强化插件**

本项目会直接安装来自 Anthropic 黑客马拉松获胜者的完整 Claude Code 配置集合。让你的 claude code 直接继承十年程序员开发功力！

生产级代理、技能、钩子、命令、规则和 MCP 配置，经过 10 多个月构建真实产品的密集日常使用而演化。

同时经过 modified，更加符合中国网络环境。

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

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，登录
2. 点击 **创建自建应用**
3. 填写应用名称（随意，比如 "My AI Assistant"）
4. 进入应用 → **添加应用能力** → 选择 **机器人**
5. 进入 **权限管理**，开通以下权限（推荐照抄，少踩坑）：
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以机器人身份发消息（避免 403）
   - `im:message.group_at_msg` — 接收群聊中 @ 机器人的消息
   - `im:message.p2p_msg` — 接收机器人单聊消息
   - `im:resource` — 上传/下载图片与文件（**收图/收视频**必须）
  
或者选择“批量导入/导出权限”复制如下

```json
{
  "scopes": {
    "tenant": [
      "im:resource",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot"
    ],
    "user": []
  }
}
```
6. 进入 **事件与回调** → **事件配置**：
   - 添加事件：`接收消息 im.message.receive_v1`
   - 请求方式选择：**使用长连接接收事件**（这是关键！）
   
   *坑点：此时要保证 codes 已在运行*
   
7. 发布应用（创建版本 → 申请上线）
8. 记下 **App ID** 和 **App Secret**（在"凭证与基础信息"页面）

## 飞书命令

在飞书中向 bot 发送以下命令：

| 命令 | 说明 |
|------|------|
| `/start [alias\|all]` | 启动项目的 Claude Code |
| `/stop [alias\|all]` | 停止项目的 Claude Code |
| `/reset [alias]` | 重置会话（清除历史，开始新对话） |
| `/interrupt [alias]` | 打断当前正在处理的消息 |
| `/cost [alias]` | 查看费用统计 |
| `/context [alias]` | 查看会话信息 |
| `/status` | 查看所有项目状态 |
| `/help` | 显示帮助 |

其他 `/` 开头的消息会直接转发给 Claude Code（如 Claude 内置的 `/compact` 等）。
普通消息直接发送给对应项目的 Claude Code 处理。

### 消息队列与打断

当 Claude 正在处理上一条消息时，新发送的消息会自动排队（单槽设计，仅保留最新一条）：

```
用户发 A  →  Claude 开始处理
用户发 B  →  "⏳ 消息已排队" → B 进入等待
用户发 C  →  "⏳ 消息已排队（替换）" → C 替换 B
A 处理完  →  回复 A 结果  →  自动开始处理 C
```

如需打断当前处理，发送 `/interrupt`：

```
用户发 A  →  Claude 处理中
用户发 /interrupt  →  打断 A  →  自动处理排队消息（如有）
```

`/cost` 和 `/context` 不受队列限制——Claude 忙碌时返回 bridge 记录的数据，空闲时透传给 Claude Code 返回详细信息。

### 延迟消息发送

/xx-dd 消息：xx 小时 dd 分钟后发送一次（例：/2-15 服务器维护）【意味着从发送起2 小时 15 分钟后，把“服务器维护”这句话发给 claude code）
/scheduled [alias]：查看当前待发送定时任务
/unschedule <任务ID前缀> [alias]：撤回单个定时任务
/unschedule all [alias]：撤回该项目全部定时任务

## 服务部署

### 一键部署（Ubuntu 24.04）

```bash
curl -fsSL https://raw.githubusercontent.com/bigbrother666sh/codes/main/deploy.sh | bash
```

脚本会自动安装 Node.js、Claude Code CLI，引导配置飞书凭据，并创建 systemd 服务。

### mcp的配置

本项目安装部署时，会自动应用 claude_enhance 里面的来自[everything-claude-code](https://github.com/affaan-m/everything-claude-code) —— The performance optimization system for AI agent harnesses. From an Anthropic hackathon winner. 的最佳实践配置，不仅能让你的 claude code 发挥最大能力，还能有效降低 token（通过细腻的分层任务自动切换不同的模型，以及跨 session 的持久记忆）

但是原版的 mcp 过于庞杂，很多也不适合国内环境，因此我精简为五个：github、memory、context7、magic、jina，这五个应该是编程都需要的

其中 github 需要你的 PAT，获取方式为：

```text
GITHUB_PERSONAL_ACCESS_TOKEN 是在 GitHub 里创建的个人访问令牌（PAT）。

打开 GitHub 的 Token 页面
https://github.com/settings/personal-access-tokens

选择创建方式

推荐：Fine-grained token（权限更细、更安全）
兼容旧工具：Tokens (classic)
按你的 MCP 用途勾权限

只读仓库：Contents: Read
需要提 Issue / PR：再加 Issues、Pull requests 的 Read and write
如果 classic token，常见最小是：repo（私有仓库）和 read:org（如需组织信息）
创建后复制 token 到 .claude.json 的 mcpserver-github 下
```

jina 需要获取 key，获取地址为：https://jina.ai/ 申请 api key，十分便宜

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
