## Project Overview

Feishu-Codex Bridge: 将飞书机器人连接到 OpenAI 开源的 Codex CLI（`codex app-server`），通过飞书消息直接操控服务器上的 Codex 子进程。每个项目一个 `codex app-server` 子进程，走 JSON-RPC 2.0 over stdio（JSONL 分帧）。

基座选型背景见 `docs/base-migration-comparison.md`（Claude Code / dsh / codex / pi 横向对比，最终选定 codex：生产级成熟度 + 第三方模型无负优化 + 自带跨会话 memory）。

## Commands

```bash
node bridge/bridge.mjs              # 启动 bridge
node bridge/bridge.mjs --selftest   # 自测模式（验证配置，不连接飞书）

# systemd 服务管理（用户级服务）
systemctl --user restart codes-feishu-bridge.service   # 重启
systemctl --user status codes-feishu-bridge.service    # 查看状态
systemctl --user stop codes-feishu-bridge.service      # 停止
systemctl --user start codes-feishu-bridge.service     # 启动
```

## Architecture

```
bridge.mjs (单 Node.js 进程)
├── loadBridgeConfig() — 读取 ~/.codes/bridge.json（projects/providers/codexDefaults）
├── 使用本机 Codex 默认配置与 CODEX_HOME，不生成 config.toml
├── CodexAppServer (每个项目一个) — 管理 codex app-server 子进程
│     ├── start(): spawn codex app-server → initialize 握手 → initialized
│     ├── _ensureThread(): thread/resume（有 threadId）或 thread/start；
│     │     per-project 的 model/reasoningEffort/modelProvider/sandbox/approvalPolicy/contextWindow
│     │     覆盖在此应用（contextWindow 走 thread 级 config.model_context_window）
│     ├── sendMessage(): turn/start 发送用户消息 → 等待 turn/completed
│     │     ├── item/agentMessage/delta — 流式增量（飞书打字机卡片）
│     │     ├── item/started/completed — 工具生命周期（进度提示）
│     │     ├── thread/tokenUsage/updated — token 统计（/cost /context）
│     │     └── 最终文本 = 最后一个 agentMessage item（工具前的过程叙述会被丢弃）
│     ├── interrupt(): turn/interrupt + 8s 看门狗兜底
│     ├── 服务端请求（审批/询问）: 全部自动应答，绝不挂起
│     │     （approvalPolicy=never 下正常不会发生）
│     └── stop(): SIGTERM → SIGKILL（5s 超时）；崩溃后下次消息自动重建连接并 resume
├── ProjectManager — 管理多个项目的进程生命周期
│     ├── init() — 按项目实例化 CodexAppServer，恢复会话，注册信号处理
│     ├── startProject/stopProject/resetProject — 按 alias 启停/重置
│     └── _saveSessions/_loadSessions — 持久化到 ~/.codes/bridge-sessions.json
└── FeishuBot (每个项目一个) — 管理飞书 WebSocket 连接
      ├── createLarkChannel (每个 bot app 一个，SDK 1.66+)
      ├── channel.on({ message, cardAction, ... }) 事件监听
      ├── channel.stream({ markdown }) 流式回复（打字机效果 + 自动 rollover）
      └── channel.send 非流式回复（slash 命令等）
```

### 沙箱与审批姿态

模型、沙箱、审批、MCP、skills 与记忆开关均由本机 Codex 管理。bridge 默认不覆盖这些配置；显式项目级 codex / codexDefaults 仍可覆盖线程参数。不会强制启用 memories。

## Key Files

| File | Purpose |
|------|---------|
| `bridge/bridge.mjs` | 核心代码：CodexAppServer, ProjectManager, FeishuBot, 消息路由 |
| `bridge/bridge.example.json` | 配置模板 |
| `bridge/setup-service.mjs` | systemd/launchd 服务生成器 |
| `bridge/package.json` | Node.js 依赖 |
| `bridge/.env.example` | 环境变量调优参考（含模型 API key 位置说明） |

## Config

- `~/.codes/bridge.json` — 项目配置（路径、飞书凭据、可选 codexDefaults、项目级 codex 覆盖：model/reasoningEffort/provider/sandbox/approvalPolicy/contextWindow）
- `~/.codes/bridge-sessions.json` — 会话持久化（自动管理；sessionId 即 codex thread id）
- `~/.codex/`（或显式 CODEX_HOME）— 本机 Codex 配置、登录、会话和记忆；bridge 不改写配置
- `bridge/.env` — 模型端点 API key（本机 Codex config.toml 的 env_key 对应变量）与可选调优变量

## Key Patterns

- **app-server 协议**: `codex app-server` 的 JSON-RPC 2.0 stdio 模式。协议基线版本 0.152.1（`EXPECTED_CODEX_VERSION`），codex stable 2-4 天一版，升级后先跑 `--selftest` + 冒烟验证
- **会话持久化**: thread id 即 session；codex rollout 落盘在 本机 Codex Home 的 `sessions/`，bridge 重启后 `thread/resume` 恢复；resume 失败（线程被删等）自动降级为新线程
- **飞书流式回复**: `channel.stream({ markdown: producer })` 使用飞书原生 streaming card（打字机效果），SDK 自动处理 throttling 和 rollover（超 30KB 自动续接新卡片）
- **过程卡只显示进度**: 最终结论一次性落卡（飞书流式卡编辑次数上限约 40 次的教训），进度编辑有 PROGRESS_EDIT_CAP，心跳 120s 一次
- **processAndReply()**: 统一的 Codex→飞书回复函数，优先走 streaming 路径，stream 启动失败时 fallback 到非流式 sendReplyToFeishu()；表格多的结论 / 超长轮次绕过流式卡，另发普通卡片
- **最终文本语义**: 一轮中最后一个 `agentMessage` item 的文本才是结论；工具调用之前的叙述文本在工具开始时丢弃（与历史 AtomCode `_finalText` 语义一致）
- **忙碌时追加消息**: 优先走 `turn/steer` 并入当前轮次（expectedTurnId 前置条件）；steer 失败（如 compact/review 等不可 steering 轮次、turn id 不匹配）时降级为单槽排队（pendingMessages Map，保留最新一条），处理完自动 drainQueue；busy 状态在 sendMessage 入口**同步**置位，杜绝并发双 turn
- **打断机制**: `/interrupt` → `turn/interrupt`，8 秒看门狗兜底强制收尾
- **服务端请求必应答**: 审批（item/commandExecution/requestApproval 等）、询问（item/tool/requestUserInput）、elicitation 全部自动应答（accept / 空答案 / decline），未知请求回 JSON-RPC error —— 任何情况下不让 turn 挂起
- **多 bot 初始化**: 每个 feishu.appId 对应独立的 createLarkChannel 实例，一个 bridge 进程可服务多个飞书 bot
- **飞书命令**: `/start`, `/stop`, `/reset`, `/interrupt`, `/model`, `/hard`, `/cost`, `/context`, `/compact`, `/status`, `/backup`, `/scheduled`, `/unschedule`, `/help` — 未识别的斜杠命令作为普通消息转发给 Codex
- **延迟发送**: `/小时-分钟 "要延迟发送的消息"` 定时发给 Codex
- **immutable config**: 配置在启动时加载，运行时不修改原始对象
- **备份**: 无每日调度，默认关闭；显式配置 backup.dest 后可通过 /backup 手动打包 .codes，不包含 ~/.codex

## CI

- `ci.yml`: Node.js 22, `npm ci`, 语法检查, `--selftest`
- Commit messages 使用 conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:` 等)
