# 重构总结：从 Go CLI 到 Node.js Bridge

## 重构背景

Codes 项目最初是一个 Go CLI 工具，提供 Claude Code 的环境配置管理、项目管理、多 Agent 协作、MCP Server 等功能。随着飞书 Bridge 的引入，项目方向发生了根本性转变。

## 动机

1. **Go 服务端冗余**：飞书 Bridge 直接管理 Claude Code 子进程，Go 服务端的 HTTP API、MCP Server、Agent 系统等不再需要作为中间层
2. **架构简化**：从 Go CLI + Go Server + Node.js Bridge 三层架构，简化为 Node.js Bridge 单层
3. **维护成本**：Go 代码库包含 19 个 package、44 个 MCP tool、TUI 界面等大量代码，与 Bridge 的实际使用场景脱节
4. **部署简化**：不再需要编译 Go 二进制，不再需要运行 `codes serve` 守护进程

## 架构对比

### 旧架构

```
飞书用户 → bridge.mjs → HTTP API → codes serve (Go)
                                      ├── internal/config
                                      ├── internal/tui
                                      ├── internal/session
                                      ├── internal/remote
                                      ├── internal/agent
                                      ├── internal/stats
                                      ├── internal/mcp (44 tools)
                                      ├── internal/commands
                                      ├── internal/output
                                      ├── internal/ui
                                      └── internal/workflow
                                            ↓
                                      Claude Code CLI
```

### 新架构

```
飞书用户 → bridge.mjs → Claude Code CLI (直接子进程管理)
              ├── ClaudeProcess (stream-json 协议)
              ├── ProjectManager (多项目生命周期)
              └── FeishuBot (WebSocket 长连接)
```

## 技术决策

### 为什么移除 Go

- Bridge 已实现 Claude Code 子进程的直接管理（spawn, stdin/stdout, resume），不需要 Go 服务端中转
- Go 的 Agent 系统、MCP Server、Workflow 系统等功能，在飞书交互场景下未被使用
- Go 的 TUI、Session 管理、Remote 管理等桌面功能与服务器部署无关

### 为什么直接管理子进程

- **stream-json 协议**：Claude CLI 支持 `--output-format stream-json --input-format stream-json`，可通过 stdin/stdout 实现结构化通信
- **会话持久化**：`--resume <session-id>` 支持跨进程重启恢复会话
- **零中间层**：消息���飞书 WebSocket 直达 Claude CLI stdin，减少延迟和故障点

## 新增核心类

### ClaudeProcess (`bridge.mjs`)

管理单个 Claude Code 子进程：
- `_spawn()` — 启动 claude 进程，设置 stream-json 模式
- `send(message)` — 通过 stdin 发送用户消息
- `_onStdout(data)` — 解析 JSONL 事件流，检测 `type:"result"` 标记轮次结束
- 自动管理 session-id，支持进程重启后以 `--resume` 恢复

### ProjectManager (`bridge.mjs`)

管理多项目的 Claude 进程生命周期：
- `init()` — 加载配置，恢复会话，注册 SIGINT/SIGTERM 处理
- `startProject(alias)` / `stopProject(alias)` — 按别名启停
- `_saveSessions()` / `_loadSessions()` — 持久化会话状态到 `~/.codes/bridge-sessions.json`

### FeishuBot（bridge.mjs 中的初始化逻辑）

每个项目对应一个飞书 bot：
- 使用 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接模式
- 每个 `feishu.appId` 创建独立的 `Lark.Client` + `Lark.WSClient`
- 处理 `im.message.receive_v1` 事件，路由到对应项目的 ClaudeProcess

## Claude stream-json 协议要点

1. 启动参数：`claude --output-format stream-json --input-format stream-json --verbose`
2. 输入：通过 stdin 发送 JSONL 格式消息
3. 输出：stdout 返回事件流，每行一个 JSON 对象
4. 轮次结束标记：`type: "result"` 事件
5. 会话恢复：`--resume <session-id>` 参数

## 迁移说明

### 已删除

- `cmd/` — Go 入口
- `internal/` — 全部 19 个 Go package
- `tools/` — Go 工具
- `go.mod`, `go.sum` — Go 模块文件
- `Makefile` — Go 构建脚本
- `install.sh`, `install.ps1` — Go 安装脚本
- `config.json.example` — Go 配置模板
- `.github/workflows/release.yml` — Go 发布流水线
- `DEPLOY.md`, `README.zh-CN.md` — 旧文档

### 保留

- `bridge/` — 核心代码（bridge.mjs, setup-service.mjs, package.json 等）
- `LICENSE` — MIT 协议

### 新增

- `docs/refactoring-summary.md` — 本文档
- `deploy.sh` — 重写为 bridge-only 部署
- `README.md` — 重写为完整文档+部署指南
- `CLAUDE.md` — 重写为 bridge-only 项目指令
- `.github/workflows/ci.yml` — 重写为 Node.js CI
