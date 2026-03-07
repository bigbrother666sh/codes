# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

Feishu-Claude Bridge: 将飞书机器人连接到 Claude Code CLI，通过飞书消息直接操控服务器上的 Claude Code 子进程。

## Commands

```bash
node bridge/bridge.mjs              # 启动 bridge
node bridge/bridge.mjs --selftest   # 自测模式（验证配置，不连接飞书）
```

## Architecture

```
bridge.mjs (单 Node.js 进程)
├── loadBridgeConfig() — 读取 ~/.codes/bridge.json
├── ClaudeProcess (每个项目一个) — 管理 claude 子进程
│     ├── spawn: claude --output-format stream-json --input-format stream-json
│     ├── stdin: 发送用户消息 (JSONL)
│     ├── stdout: 读取事件流，检测 type:"result" 标记轮次结束
│     └── respawn: 下次消息时以 --resume <session-id> 自��重启
├── ProjectManager — 管理多个项目的 Claude 进程生命周期
│     ├── init() — 加载配置，恢复会话，注册信号处理
│     ├── startProject/stopProject — 按 alias 启停
│     └── _saveSessions/_loadSessions — 持久化到 ~/.codes/bridge-sessions.json
└── FeishuBot (每个项目一个) — 管理飞书 WebSocket 连接
      ├── Lark.Client + Lark.WSClient (每个 bot app 一套)
      ├── EventDispatcher 处理 im.message.receive_v1
      └── sendText/sendMedia 回复
```

## Key Files

| File | Purpose |
|------|---------|
| `bridge/bridge.mjs` | 核心代码：ClaudeProcess, ProjectManager, FeishuBot, 消息路由 |
| `bridge/bridge.example.json` | 配置模板 |
| `bridge/setup-service.mjs` | systemd/launchd 服务生成器 |
| `bridge/package.json` | Node.js 依赖 |
| `bridge/.env.example` | 环境变量调优参考 |

## Config

- `~/.codes/bridge.json` — 项目配置（路径、飞书 AppID、secret 路径）
- `~/.codes/bridge-sessions.json` — 会话持久化（自动管理）
- `bridge/.env` — 可选环境变量覆盖

## Key Patterns

- **stream-json 协议**: Claude CLI 的 `--output-format stream-json --input-format stream-json` 模式，stdin/stdout 通过 JSONL 通信
- **会话持久化**: ClaudeProcess 自动保存 session-id，进程重启后以 `--resume` 恢复
- **多 bot 初始化**: 每个 feishu.appId 对应独立的 Lark.Client + WSClient，一个 bridge 进程可服务多个飞书 bot
- **飞书命令**: `/start`, `/stop`, `/reset`, `/interrupt`, `/cost`, `/context`, `/status`, `/help` — 以 `/` 开头的消息作为控制命令处理；未识别的斜杠命令透传给 Claude Code
- **消息队列**: 单槽设计（pendingMessages Map），Claude 忙碌时新消息排队（保留最新一条），处理完自动 drainQueue
- **打断机制**: `/interrupt` 发送 SIGINT，ClaudeProcess._interrupted 标记使 _onProcessExit 走 resolve 路径而非 reject
- **延迟发送**：`/小时-分钟 “要延迟发送的消息”` xx 小时 xxx 分钟后，内容发给 claude code
- **immutable config**: 配置在启动时加载，运行时不修改原始对象

## CI

- `ci.yml`: Node.js 22, `npm ci`, 语法检查, `--selftest`
- Commit messages 使用 conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:` 等)
