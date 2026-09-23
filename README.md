# Codes — 打造你专属的 7*24 小时云端开发牛马（基于 Codex）

简单说，就是把 OpenAI 开源的 **Codex CLI** 装在云服务器上，然后接入飞书。这样你就可以让它 7*24 为你开发了——你只管通过飞书下达指令，讨论实现方案、出开发计划、最终的开发实现、部署上线……你只需要用手机、飞书对话，懂不懂技术都没所谓。

<img src="docs/codes.png" alt="codes running demo" style="width: 100%;"/>

即便你是编程老手，这个模式也很有价值：从电脑前彻底解放，随时随地……搭配上豆包语音输入，打字都不需要了。

# 🌟 为什么是 Codex

- **生产级成熟度**：OpenAI 官方开源（Apache-2.0），Rust 实现，2-4 天一个 stable 版本
- **对第三方模型友好**：走标准 OpenAI Responses API，任何兼容端点都能接（Anthropic 生态封闭、对第三方模型负优化的问题不存在）
- **自带跨会话持久记忆**：内置两阶段 memory 管线（会话结束自动提取 → 全局合并），无需外挂 memory MCP
- **会话原生持久化**：rollout 落盘 + `thread/resume` 跨进程恢复，进程重启不丢上下文
- **结构化审批协议**：命令/文件改动审批是 JSON-RPC 请求/应答，天然可桥接飞书审批卡（规划中）
- **每项目独立 Provider**：同一个 bridge 里，项目 A 走 GLM、项目 B 走 Qwen，`bridge.json` 一行配置

> 基座选型过程见 [docs/base-migration-comparison.md](docs/base-migration-comparison.md)（Claude Code / dsh / codex / pi 横向对比）。

# 功能亮点

🚀【2026.9.2】**基座切换为 Codex**：bridge 通过 `codex app-server`（JSON-RPC over stdio）完整桥接 Codex 的 IO——流式增量文本、打断、跨进程会话恢复、审批应答、token 统计。

🚀 直接复用本机 Codex 配置、登录与 skills，无需单独配置模型

🚀 延迟消息（计划消息）：`/小时-分钟 “要延迟发送的消息”`（xx 小时 xx 分钟后，内容发给 Codex）

- 不需要任何订阅，走你自己的模型服务端点；
- 国内的 GLM、Qwen、DeepSeek 等 coding 套餐（任何 OpenAI Responses 兼容端点）都能直接用；
- 没有海外账号、网络环境的麻烦。

至于云端服务器，2C4G 足够了，腾讯云首单一年 79……当然本项目不需要公网 IP，你搞台二手电脑装个 ubuntu 扔家里或者办公室也是可以的……硬件几乎零成本。

**🌹 致敬：飞书连接桥方案来自：https://github.com/AlexAnys/feishu-openclaw**

## 架构

```
飞书用户 ──WebSocket──▶ bridge.mjs ──stdio JSON-RPC──▶ codex app-server
                         │                                  │
                    ProjectManager                    CodexAppServer
                    (多项目管理)                  (initialize/thread/turn
                         │                         item delta/审批应答)
                    createLarkChannel × N
                    (每个项目一个飞书 bot)
```

- **bridge.mjs** — 单 Node.js 进程，同时服务多个飞书 bot + 多个 Codex 子进程
- **CodexAppServer** — 每个项目一个 `codex app-server` 子进程：`initialize` 握手 → `thread/start`（新会话）或 `thread/resume`（恢复会话）→ `turn/start` 发消息，`item/agentMessage/delta` 流式增量 → 飞书打字机卡片；`turn/interrupt` 打断；所有服务端请求（审批等）自动应答，绝不挂起
- **ProjectManager** — 管理多项目生命周期，每个项目独立的 Codex 实例和飞书 bot
- **本机 Codex** — 继承本机默认配置与 `CODEX_HOME`（通常为 `~/.codex`），不生成或覆盖 Codex 配置。`.codes` 只保存 bridge 配置、飞书凭据、日志和会话映射。
- **createLarkChannel** — 飞书 SDK 1.66+ 高层 API，封装 WebSocket 连接、消息归一化、流式卡片、卡片交互回调

### 飞书 SDK 能力

| 能力 | 说明 |
|------|------|
| **消息归一化** | SDK 自动将 text/post/interactive/merge_forward 等消息类型归一化为统一格式 |
| **流式卡片** | CardKit 2.0 + `streaming_mode`，实时推送 Codex 输出到飞书卡片 |
| **卡片交互** | `cardAction` 回调，支持停止按钮等交互操作 |
| **Reaction v1** | 使用 `im.v1.messageReaction` API（v0 已弃用） |
| **WS 调优** | `pingTimeout: 3s`，`handshakeTimeoutMs: 8000`，应用层重连事件 |
| **Bot 身份** | `channel.botIdentity` 自动获取 bot 的 open_id |
| **优雅关闭** | `channel.disconnect()` 优雅断开 WebSocket |

## 前置要求

- **Node.js** 22+
- **@larksuiteoapi/node-sdk** 1.66.0（飞书 SDK，bridge 自带）
- **Codex CLI** — `npm install -g @openai/codex`（协议基线版本：0.152.1）
- **本机 Codex 已配置并能正常使用**（登录或模型端点配置均由 Codex 管理）
- **飞书自建应用** — 需要 App ID + App Secret（详见下方配置步骤）

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/bigbrother666sh/codes.git
cd codes/bridge
npm install
npm install -g @openai/codex
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
  "codexPath": "codex",
  "debug": false
}
```

将飞书 App Secret 写入 secret 文件：

```bash
echo -n "your-app-secret" > ~/.codes/secrets/myapp_secret
chmod 600 ~/.codes/secrets/myapp_secret
```

先在终端确认 `codex` 能正常工作。bridge 使用同一套 Codex 配置、登录、MCP 和记忆设置。

在仓库根目录运行 `./deploy.sh` 可安装 bridge 依赖并启用用户服务；已有 `~/.codes/bridge.json` 会直接复用，不覆盖项目和凭据。脚本不安装或重新配置 Codex。

### 3. 启动

```bash
node bridge.mjs
```

## 配置说明

### bridge.json 字段

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `projects` | 项目配置 map（alias → {path, feishu, codex?}） | 必填 |
| `projects.*.path` | 项目代码仓路径 | 必填 |
| `projects.*.feishu.appId` | 飞书 App ID | 必填 |
| `projects.*.feishu.appSecretPath` | Secret 文件路径 | 必填 |
| `codexPath` | 本机 codex CLI 路径，服务中建议使用绝对路径 | `"codex"` |
| `thinkingThresholdMs` | 进度提示阈值（ms） | 2500 |
| `debug` | 调试模式 | `false` |
| `backup` | 可选手动备份配置（如 `{ "dest": "~/Backups" }`） | `false` |

默认不传模型、推理强度、provider、沙箱、审批或上下文配置覆盖，全部由本机 Codex 决定。可通过 `codexDefaults.model` 和 `codexDefaults.reasoningEffort` 设置所有项目的新会话及 `/reset` 默认值，例如 `gpt-6-sol` 和 `xhigh`；`projects.*.codex` 可覆盖单个项目。provider 必须已在本机 Codex 中定义。旧的 `providers`、`mcpServers` 字段不再生成配置，需要在本机 Codex 中维护。

bridge 不再安排每日备份。仅显式配置 `backup.dest` 后，`/backup` 才能手动打包 `.codes`；它不包含默认 `~/.codex`。

已有 `.codes/codex-home` 不会删除或迁移。旧线程不在当前 Codex Home 时，恢复失败会新建线程；旧历史仍留在原目录。

### .env 调优（可选）

参见 `bridge/.env.example`。用户服务如需额外环境变量，可放在 `~/.codes/bridge.env`；bridge 自身也会加载 `bridge/.env`。模型配置和登录由本机 Codex 管理。

### 飞书自建应用创建步骤

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，登录
2. 点击 **创建自建应用**
3. 填写应用名称（随意，比如 "My AI Assistant"）
4. 进入应用 → **添加应用能力** → 选择 **机器人**
5. 进入 **权限管理**，开通以下权限（推荐照抄，少踩坑）：
   - `cardkit:card:write` — 发送/更新交互卡片（**streaming 流式回复**必须，否则回退为普通文本）
   - `im:message` — 获取与发送消息
   - `im:message:send_as_bot` — 以机器人身份发消息（避免 403）
   - `im:message.group_at_msg` — 接收群聊中 @ 机器人的消息
   - `im:message.p2p_msg` — 接收机器人单聊消息
   - `im:resource` — 上传/下载图片与文件（**收图/收视频**必须）

或者选择"批量导入/导出权限"复制如下

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:write",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:resource"
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
| `/start [alias\|all]` | 启动项目的 Codex 会话 |
| `/stop [alias\|all]` | 停止项目的 Codex 会话 |
| `/reset [alias]` | 重置会话并恢复项目默认模型和推理强度 |
| `/interrupt [alias]` | 打断当前正在处理的消息 |
| `/model [名称] [alias]` | 查看或切换模型（下一条消息生效） |
| `/hard [alias]` | 切换到 `gpt-6-astra` + `high`（下一条消息生效） |
| `/cost [alias]` | 查看 token 用量（累计/上一轮） |
| `/context [alias]` | 查看上下文窗口占用 |
| `/compact [alias]` | 压缩会话历史 |
| `/status` | 查看所有项目状态 |
| `/backup` | 立即触发一次备份 |
| `/help` | 显示帮助 |

其他 `/` 开头的消息会作为普通消息转发给 Codex。
普通消息直接发送给对应项目的 Codex 处理。
项目停止后再次 `/start` 也会恢复默认模型和推理强度，但保留会话历史。

### 消息队列与打断

当 Codex 正在处理上一条消息时，新发送的消息会自动排队（单槽设计，仅保留最新一条）：

```
用户发 A  →  Codex 开始处理
用户发 B  →  "⏳ 消息已排队" → B 进入等待
用户发 C  →  "⏳ 消息已排队（替换）" → C 替换 B
A 处理完  →  回复 A 结果  →  自动开始处理 C
```

如需打断当前处理，发送 `/interrupt`（映射到 `turn/interrupt`）。

### 延迟消息发送

/xx-dd 消息：xx 小时 dd 分钟后发送一次（例：/2-15 服务器维护）【意味着从发送起 2 小时 15 分钟后，把"服务器维护"这句话发给 Codex】
/scheduled [alias]：查看当前待发送定时任务
/unschedule <任务ID前缀> [alias]：撤回单个定时任务
/unschedule all [alias]：撤回该项目全部定时任务

## 服务部署

### 手动部署

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 Codex CLI
npm install -g @openai/codex

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

> systemd 环境下注意：`bridge.json` 的 `codexPath` 建议写 codex 二进制的**绝对路径**（`which codex` 查看）；模型 API key 通过 `bridge/.env` 提供，不依赖 shell 环境变量。

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
| 启动报 `Cannot find codex CLI` | 确认 `codexPath` 指向可执行的 codex 二进制（systemd 下用绝对路径） |
| 回复"模型认证失败"类错误 | 检查 `bridge/.env` 中 `envKey` 对应的变量是否已设置 |
| 日志出现 bwrap/user namespace 警告 | 本机不支持沙箱，默认配置已用 `danger-full-access`，可忽略 |
| 进程重启后会话丢失 | 正常行为——bridge 会自动以 `thread/resume` 恢复上次会话 |
| 多项目配置不生效 | 确认每个项目的 `feishu.appId` 不同，每个 bot 对应一个项目 |

## 自测

```bash
node bridge/bridge.mjs --selftest
```

验证配置加载和基本功能，不会连接飞书。

## License

MIT
