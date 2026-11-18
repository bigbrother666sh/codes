## Project Overview

Feishu-Codex Bridge: 将飞书机器人连接到 OpenAI 开源的 Codex CLI（`codex app-server`），通过飞书消息直接操控服务器上的 Codex 子进程。每个群聊/私聊会话一个 `codex app-server` 子进程，走 JSON-RPC 2.0 over stdio（JSONL 分帧）。

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
├── CodexAppServer (每个聊天会话一个) — 管理 codex app-server 子进程
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
└── FeishuBot (每个项目绑定一个 bot App，群聊与私聊共用连接) — 管理飞书 WebSocket 连接
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
| `bridge/conversations.mjs` | 项目与 bot 绑定校验、群聊消息累积与拼接 |
| `bridge/conversations.test.mjs` | bot 绑定/群聊累积单元测试 |
| `bridge/notices.mjs` | 记录 bridge 系统回执消息 ID，跨 bot 排除群背景噪声 |
| `bridge/notices.test.mjs` | 回执过滤、发送与事件竞态、持久化及缓冲清理测试 |
| `bridge/bridge.example.json` | 配置模板 |
| `bridge/setup-service.mjs` | systemd/launchd 服务生成器 |
| `bridge/package.json` | Node.js 依赖 |
| `bridge/.env.example` | 环境变量调优参考（含模型 API key 位置说明） |

## Config

- `~/.codes/bridge.json` — 项目配置（路径、飞书凭据、可选 codexDefaults、项目级 codex 覆盖：model/reasoningEffort/provider/sandbox/approvalPolicy/contextWindow）
- `~/.codes/bridge-sessions.json` — 会话持久化（自动管理；sessionId 即 codex thread id）
- `~/.codes/bridge-notices.json` — bridge 系统回执消息 ID（自动管理、有界保存；重启后仍可过滤迟到的回执）
- `~/.codex/`（或显式 CODEX_HOME）— 本机 Codex 配置、登录、会话和记忆；bridge 不改写配置
- `bridge/.env` — 模型端点 API key（本机 Codex config.toml 的 env_key 对应变量）与可选调优变量

## Key Patterns

- **app-server 协议**: `codex app-server` 的 JSON-RPC 2.0 stdio 模式。协议基线版本 0.169.0（`EXPECTED_CODEX_VERSION`），codex stable 2-4 天一版，升级后先跑 `--selftest` + 冒烟验证
- **会话持久化**: thread id 即 session；codex rollout 落盘在 本机 Codex Home 的 `sessions/`，bridge 重启后 `thread/resume` 恢复；resume 失败（线程被删等）自动降级为新线程
- **飞书流式回复**: `channel.stream({ markdown: producer })` 使用飞书原生 streaming card（打字机效果），SDK 自动处理 throttling 和 rollover（超 30KB 自动续接新卡片）
- **过程卡只显示进度**: 最终结论一次性落卡（飞书流式卡编辑次数上限约 40 次的教训），进度编辑有 PROGRESS_EDIT_CAP，心跳 120s 一次
- **processAndReply()**: 统一的 Codex→飞书回复函数，优先走 streaming 路径，stream 启动失败时 fallback 到非流式 sendReplyToFeishu()；表格多的结论 / 超长轮次绕过流式卡，另发普通卡片
- **最终文本语义**: 一轮中最后一个 `agentMessage` item 的文本才是结论；工具调用之前的叙述文本在工具开始时丢弃（与历史 AtomCode `_finalText` 语义一致）
- **忙碌时追加消息**: 优先走 `turn/steer` 并入当前轮次（expectedTurnId 前置条件）；steer 失败（如 compact/review 等不可 steering 轮次、turn id 不匹配）时降级为按会话排队（pendingMessages Map，私聊保留最新一条，群聊合并各批请求），处理完自动 drainQueue；busy 状态在 sendMessage 入口**同步**置位，杜绝并发双 turn
- **打断机制**: `/interrupt` → `turn/interrupt`，8 秒看门狗兜底强制收尾
- **服务端请求必应答**: 审批（item/commandExecution/requestApproval 等）、询问（item/tool/requestUserInput）、elicitation 全部自动应答（accept / 空答案 / decline），未知请求回 JSON-RPC error —— 任何情况下不让 turn 挂起
- **群聊累积与会话隔离**: 群聊普通消息只响应 @ 当前机器人，其他普通消息带发信人/时间/正文逐条落盘到 `~/.codes/bridge-group-messages.json`；@ 时取出背景与当前请求拼接，提交失败恢复。Slash 命令无需 @，收到后直接执行；`/clear` 和 `/reset` 同时清空未发送给 AI 的积累及待处理请求，其他管理命令保留背景。未 @ 的未知 Slash 命令直接转给 Codex并保留积累，带 @ 则一起发送背景。每个群与每个私聊独立 CodexAppServer/thread/队列，首个私聊保留旧 alias/thread；每个 bot 固定绑定一个项目及其目录/默认 Codex 配置，群聊和私聊只是输入输出通道；无需为群聊另配项目条目，每个群聊自动使用 `alias:group:chat_id` 运行时标识。同群多 bot 各自积累并只响应 @ 自己的普通消息，各 bot 建立独立的 WebSocket。AI 忙碌时 @ 请求优先 `turn/steer` 并入当前轮次，失败时合并排队，保留每批背景与请求。
- **多 bot 初始化**: 每个 feishu.appId 对应独立的 createLarkChannel 实例及 `new Lark.DefaultCache()`。SDK 默认使用进程共享缓存，消息去重键不含 appId，同群多个 bot 会误丢彼此已经处理的消息；不能省略独立 cache。SDK 的 @all 过滤放开，由 bridge 自身决定仅累积或响应。自测包含真实 SDK 归一化/去重入口。
- **仅私聊项目**: `projects.*.feishu.allowGroupChats=false` 会忽略该项目全部群输入（含 @、Slash 和定时恢复），启动时移除已保存的群会话映射及未发送背景；私聊与其他项目不受影响。未配置时默认允许群聊。
- **停用群组**: `disabledGroupChats` 为全局停用群 chat ID 数组；对所有 bot 跳过该群的会话恢复、输入与定时恢复，启动时清除对应会话映射和未发送背景。旧进程退出时写回的映射也会在下次启动清理。
- **群聊回执过滤**: bot 自身消息直接跳过；bridge 命令回执、排队/steer 提示、定时通知和普通文本进度在发送时标记，所有 bot 按同一消息 ID 排除。事件先于发送响应时，仅匹配当前群正在发送的完整回执/文本分片且 sender_type=app；用户引用相同文字及其他 bot 的 AI 回复保留。已登记回执如遗留在群缓冲，启动时清理；不在服务运行中直接改写缓冲文件。
- **飞书命令**: `/start`, `/stop`, `/reset`, `/interrupt`, `/model`, `/hard`, `/cost`, `/context`, `/compact`, `/status`, `/backup`, `/scheduled`, `/unschedule`, `/help` — 未识别的斜杠命令作为普通消息转发给 Codex
- **延迟发送**: `/小时-分钟 "要延迟发送的消息"` 定时发给 Codex
- **immutable config**: 配置在启动时加载，运行时不修改原始对象
- **备份**: 无每日调度，默认关闭；显式配置 backup.dest 后可通过 /backup 手动打包 .codes，不包含 ~/.codex

## CI

- `ci.yml`: Node.js 22, `npm ci`, 语法检查, `npm test`（bot 绑定/累积/回执过滤测试 + `--selftest`）
- Commit messages 使用 conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:` 等)
