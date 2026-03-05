#!/usr/bin/env bash
# ============================================================================
# Feishu-Claude Bridge — Ubuntu 24.04 一键部署脚本
#
# 用法:
#   curl -fsSL <url>/deploy.sh | bash
#   或: chmod +x deploy.sh && ./deploy.sh
#
# 前置要求: Ubuntu 24.04 服务器 + root/sudo 权限
# ============================================================================

set -euo pipefail

# ─── 颜色输出 ─────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
fatal() { err "$*"; exit 1; }

# ─── 配置变量 ─────────────────────────────────────────────────────
NODE_MAJOR=22
CODES_REPO="https://github.com/bigbrother666sh/codes.git"
CODES_DIR="$HOME/codes"

# ─── 检测环境 ─────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Feishu-Claude Bridge 一键部署"
echo "  目标: Ubuntu 24.04"
echo "============================================"
echo ""

if [ "$(id -u)" = "0" ]; then
  warn "检测到 root 用户运行。建议使用普通用户 + sudo。"
  echo ""
fi

# ─── Phase 1: 系统依赖 ────────────────────────────────────────────
info "Phase 1/7: 安装系统依赖..."

sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq > /dev/null 2>&1
ok "系统依赖已安装"

# ─── Phase 2: Node.js ────────────────────────────────────────────
info "Phase 2/7: 安装 Node.js ${NODE_MAJOR}.x..."

if command -v node &>/dev/null; then
  ok "Node.js 已安装: $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - > /dev/null 2>&1
  sudo apt-get install -y -qq nodejs > /dev/null 2>&1
  ok "Node.js $(node --version) 已安装"
fi

# 配置 npm 用户级全局目录（使 Claude Code 可自动更新）
NPM_GLOBAL="$HOME/.npm-global"
mkdir -p "$NPM_GLOBAL"
npm config set prefix "$NPM_GLOBAL"

if ! grep -q '.npm-global/bin' "$HOME/.profile" 2>/dev/null; then
  echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> "$HOME/.profile"
fi
export PATH="$NPM_GLOBAL/bin:$PATH"

# ─── Phase 3: Claude Code CLI ────────────────────────────────────
info "Phase 3/7: 安装 Claude Code CLI..."

if command -v claude &>/dev/null; then
  ok "Claude Code 已安装: $(claude --version 2>/dev/null || echo 'unknown')"
else
  npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
  ok "Claude Code $(claude --version 2>/dev/null || echo '') 已安装"
fi

# ─── Phase 4: 克隆仓库 + 安装依赖 ────────────────────────────────
info "Phase 4/7: 克隆仓库并安装依赖..."

if [ -d "$CODES_DIR" ]; then
  info "codes 目录已存在，执行 git pull..."
  cd "$CODES_DIR" && git pull --ff-only
else
  git clone "$CODES_REPO" "$CODES_DIR"
fi

cd "$CODES_DIR/bridge"
npm install --production > /dev/null 2>&1
ok "bridge 依赖已安装"

# ─── Phase 5: 交互式配置 ──────────────────────────────────────────
info "Phase 5/7: 配置..."

echo ""
echo "============================================"
echo "  现在需要你提供几个配置值"
echo "============================================"
echo ""

# --- Claude Code 配置 ---
echo -e "${BLUE}[1/3] Claude Code API 配置${NC}"
echo "  你使用的是:"
echo "    1) Anthropic 官方 API (api.anthropic.com)"
echo "    2) 第三方代理 / 自部署 API"
read -rp "  选择 (1/2) [1]: " API_CHOICE
API_CHOICE=${API_CHOICE:-1}

if [ "$API_CHOICE" = "1" ]; then
  ANTHROPIC_BASE_URL="https://api.anthropic.com"
  read -rsp "  请输入 Anthropic API Key: " ANTHROPIC_API_KEY
  echo ""
  ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_API_KEY"
else
  read -rp "  请输入 API Base URL: " ANTHROPIC_BASE_URL
  read -rsp "  请输入 Auth Token: " ANTHROPIC_AUTH_TOKEN
  echo ""
fi

# --- 飞书配置 ---
echo ""
echo -e "${BLUE}[2/3] 飞书配置${NC}"
read -rp "  飞书 App ID (cli_xxx): " FEISHU_APP_ID
read -rsp "  飞书 App Secret: " FEISHU_APP_SECRET
echo ""

# --- 项目配置 ---
echo ""
echo -e "${BLUE}[3/3] 项目配置${NC}"
read -rp "  项目别名 (如 myapp): " PROJECT_ALIAS
PROJECT_ALIAS=${PROJECT_ALIAS:-myapp}
read -rp "  项目代码仓路径 [${HOME}/projects/${PROJECT_ALIAS}]: " PROJECT_PATH
PROJECT_PATH=${PROJECT_PATH:-"$HOME/projects/$PROJECT_ALIAS"}
mkdir -p "$PROJECT_PATH"

echo ""
info "正在写入配置文件..."

# ─── 写入配置 ───────────────────────────────��─────────────────────
mkdir -p "$HOME/.codes/secrets"
mkdir -p "$HOME/.codes/logs"

# 飞书 secret
echo -n "$FEISHU_APP_SECRET" > "$HOME/.codes/secrets/${PROJECT_ALIAS}_secret"
chmod 600 "$HOME/.codes/secrets/${PROJECT_ALIAS}_secret"
ok "飞书 secret 已写入"

# bridge.json
cat > "$HOME/.codes/bridge.json" << BRIDGEEOF
{
  "projects": {
    "${PROJECT_ALIAS}": {
      "path": "${PROJECT_PATH}",
      "feishu": {
        "appId": "${FEISHU_APP_ID}",
        "appSecretPath": "~/.codes/secrets/${PROJECT_ALIAS}_secret"
      }
    }
  },
  "claudePath": "claude",
  "debug": false
}
BRIDGEEOF
chmod 600 "$HOME/.codes/bridge.json"
ok "bridge.json 已写入: ~/.codes/bridge.json"

# ─── Claude Code 配置 ─────────────────────────────────────────────
if [ -d "$HOME/.claude" ] && [ -f "$HOME/.claude/settings.json" ]; then
  ok "检测到已有 ~/.claude 配置，跳过"
else
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/settings.json" << 'SETTINGSEOF'
{
  "model": "sonnet",
  "effortLevel": "high",
  "language": "简体中文"
}
SETTINGSEOF
  ok "已创建最小 Claude Code 配置"

  warn "请确保设置 Claude Code 的 API 凭据:"
  echo "  export ANTHROPIC_BASE_URL=\"${ANTHROPIC_BASE_URL}\""
  echo "  export ANTHROPIC_API_KEY=\"${ANTHROPIC_AUTH_TOKEN}\""
  echo ""
  echo "  建议写入 ~/.profile 或 ~/.bashrc"
fi

# 写入 bridge.env（供 systemd 服务读取）
cat > "$HOME/.codes/bridge.env" << ENVEOF
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
ANTHROPIC_API_KEY=${ANTHROPIC_AUTH_TOKEN}
ENVEOF
chmod 600 "$HOME/.codes/bridge.env"
ok "API 环境变量已写入 ~/.codes/bridge.env"

# 同时写入 ~/.bashrc（供 SSH 登录后手动使用 claude 命令）
if ! grep -q 'ANTHROPIC_BASE_URL' "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ""
    echo "# Claude Code API"
    echo "export ANTHROPIC_BASE_URL=\"${ANTHROPIC_BASE_URL}\""
    echo "export ANTHROPIC_API_KEY=\"${ANTHROPIC_AUTH_TOKEN}\""
  } >> "$HOME/.bashrc"
  ok "API 环境变量已写入 ~/.bashrc"
fi

# ─── Phase 6: Claude Enhance 安装 ─────────────────────────────────
info "Phase 6/7: 安装 Claude Enhance..."

ENHANCE_DIR="$CODES_DIR/claude_enhance"
CLAUDE_DIR="$HOME/.claude"

if [ ! -d "$ENHANCE_DIR" ]; then
  warn "claude_enhance 目录不存在，跳过增强安装"
else
  # 6.1: 创建目录结构
  mkdir -p "$CLAUDE_DIR/agents"
  mkdir -p "$CLAUDE_DIR/commands"
  mkdir -p "$CLAUDE_DIR/contexts"
  mkdir -p "$CLAUDE_DIR/scripts/hooks"
  mkdir -p "$CLAUDE_DIR/scripts/lib"
  mkdir -p "$CLAUDE_DIR/skills"
  mkdir -p "$CLAUDE_DIR/rules/common"
  mkdir -p "$CLAUDE_DIR/rules/typescript"
  mkdir -p "$CLAUDE_DIR/rules/python"
  mkdir -p "$CLAUDE_DIR/rules/golang"

  # 6.2: 安装 agents
  cp "$ENHANCE_DIR/agents/"*.md "$CLAUDE_DIR/agents/"
  ok "agents 已安装 ($(ls "$ENHANCE_DIR/agents/"*.md | wc -l) 个)"

  # 6.3: 安装 rules
  cp "$ENHANCE_DIR/rules/common/"*.md "$CLAUDE_DIR/rules/common/"
  cp "$ENHANCE_DIR/rules/typescript/"*.md "$CLAUDE_DIR/rules/typescript/"
  cp "$ENHANCE_DIR/rules/python/"*.md "$CLAUDE_DIR/rules/python/"
  cp "$ENHANCE_DIR/rules/golang/"*.md "$CLAUDE_DIR/rules/golang/"
  ok "rules 已安装 (common, typescript, python, golang)"

  # 6.4: 安装 commands（处理与内置命令的冲突）
  # Claude Code 内置命令: /plan (切换 Plan 模式)
  BUILTIN_COMMANDS="plan"
  CMD_COUNT=0
  CMD_RENAMED=0
  for cmd_file in "$ENHANCE_DIR/commands/"*.md; do
    name=$(basename "$cmd_file" .md)
    if echo "$BUILTIN_COMMANDS" | grep -qw "$name"; then
      cp "$cmd_file" "$CLAUDE_DIR/commands/enhance-${name}.md"
      CMD_RENAMED=$((CMD_RENAMED + 1))
      info "  /${name} → /enhance-${name} (避免与内置命令冲突)"
    else
      cp "$cmd_file" "$CLAUDE_DIR/commands/${name}.md"
    fi
    CMD_COUNT=$((CMD_COUNT + 1))
  done
  ok "commands 已安装 (${CMD_COUNT} 个, ${CMD_RENAMED} 个重命名)"

  # 6.5: 安装 skills（���留完整子目录结构）
  cp -r "$ENHANCE_DIR/skills/"* "$CLAUDE_DIR/skills/"
  SKILL_COUNT=$(find "$ENHANCE_DIR/skills" -maxdepth 1 -mindepth 1 -type d | wc -l)
  ok "skills 已安装 (${SKILL_COUNT} 个)"

  # 6.6: 安装 contexts
  cp "$ENHANCE_DIR/contexts/"*.md "$CLAUDE_DIR/contexts/"
  ok "contexts 已安装"

  # 6.7: 安装 scripts（hooks 和 lib 脚本）
  cp -r "$ENHANCE_DIR/scripts/hooks/"* "$CLAUDE_DIR/scripts/hooks/" 2>/dev/null || true
  cp -r "$ENHANCE_DIR/scripts/lib/"* "$CLAUDE_DIR/scripts/lib/" 2>/dev/null || true
  # 复制其他顶层脚本
  for f in "$ENHANCE_DIR/scripts/"*.js "$ENHANCE_DIR/scripts/"*.sh; do
    [ -f "$f" ] && cp "$f" "$CLAUDE_DIR/scripts/"
  done
  ok "scripts 已安装"

  # 6.8: 合并 hooks 到 settings.json + MCP servers 到 .claude.json
  # 使用 Node.js 处理 JSON 合并（避免 jq 转义问题）
  ENHANCE_DIR="$ENHANCE_DIR" CLAUDE_DIR="$CLAUDE_DIR" node << 'MERGE_EOF'
const fs = require('fs');
const path = require('path');

const enhanceDir = process.env.ENHANCE_DIR;
const claudeDir = process.env.CLAUDE_DIR;
const home = process.env.HOME;

// ── 处理 hooks ──────────────────────────────────────────
const hooksPath = path.join(enhanceDir, 'hooks', 'hooks.json');
const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));

// 去掉 "Block creation of random .md files" hook
hooksConfig.hooks.PreToolUse = hooksConfig.hooks.PreToolUse.filter(
  h => !h.description.includes('Block creation of random .md files')
);

// 替换 ${CLAUDE_PLUGIN_ROOT} 为实际安装路径
let hooksJson = JSON.stringify(hooksConfig.hooks);
hooksJson = hooksJson.split('${CLAUDE_PLUGIN_ROOT}').join(claudeDir);
const processedHooks = JSON.parse(hooksJson);

// 读取或创建 settings.json
const settingsPath = path.join(claudeDir, 'settings.json');
let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

// 合并 hooks
settings.hooks = processedHooks;

// 设置默认模型（若未配置）
settings.model = settings.model || 'sonnet';
settings.effortLevel = settings.effortLevel || 'high';

// 移除 everything-claude-code 插件引用（已改为直接安装）
if (settings.enabledPlugins) {
  delete settings.enabledPlugins['everything-claude-code@everything-claude-code'];
  if (Object.keys(settings.enabledPlugins).length === 0) {
    delete settings.enabledPlugins;
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.error('[OK] hooks 已合并到 settings.json');

// ── 合并 MCP servers ────────────────────────────────────
const claudeJsonPath = path.join(home, '.claude.json');
const mcpConfigPath = path.join(enhanceDir, 'mcp-configs', 'mcp-servers.json');

if (fs.existsSync(claudeJsonPath) && fs.existsSync(mcpConfigPath)) {
  const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  const mcpContent = fs.readFileSync(mcpConfigPath, 'utf8');

  // mcp-servers.json 是 JSON 片段，需要包裹成完整 JSON
  let newServers = {};
  try {
    const wrapped = JSON.parse('{' + mcpContent + '}');
    newServers = wrapped.mcpServers || {};
  } catch (e) {
    console.error('[WARN] mcp-servers.json 解析失败: ' + e.message);
  }

  if (!claudeJson.mcpServers) {
    claudeJson.mcpServers = {};
  }

  // 只添加不存在的 MCP 服务器（不覆盖已有配置和 token）
  let added = 0;
  for (const [name, config] of Object.entries(newServers)) {
    if (!claudeJson.mcpServers[name]) {
      claudeJson.mcpServers[name] = config;
      added++;
    }
  }

  if (added > 0) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    console.error('[OK] MCP 服务器: 新增 ' + added + ' 个');
  } else {
    console.error('[OK] MCP 服务器: 全部已存在，无需更新');
  }
} else if (!fs.existsSync(claudeJsonPath)) {
  console.error('[WARN] ~/.claude.json 不存在，跳过 MCP 配置');
}
MERGE_EOF

  ok "Claude Enhance 安装完成"
fi

# ─── Phase 7: 创建 systemd 服务 ──────��───────────────────────────
info "Phase 7/7: 创建 systemd 服务..."

cd "$CODES_DIR/bridge"
node setup-service.mjs

echo ""
info "启用并启动服务..."

systemctl --user daemon-reload
systemctl --user enable codes-feishu-bridge
systemctl --user start codes-feishu-bridge

sleep 2

if systemctl --user is-active --quiet codes-feishu-bridge; then
  ok "feishu-bridge 已启动"
else
  warn "feishu-bridge 可能未正常启动，请检查:"
  echo "  journalctl --user -u codes-feishu-bridge -f"
fi

# ─── 完成 ─────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo -e "  ${GREEN}部署完成!${NC}"
echo "============================================"
echo ""
echo "  服务管理:"
echo "    systemctl --user status codes-feishu-bridge"
echo "    systemctl --user restart codes-feishu-bridge"
echo "    journalctl --user -u codes-feishu-bridge -f"
echo ""
echo "  重要文件:"
echo "    bridge 配置:   ~/.codes/bridge.json"
echo "    飞书 secret:   ~/.codes/secrets/${PROJECT_ALIAS}_secret"
echo "    Claude Code:   ~/.claude/"
echo "    Claude Enhance: ~/codes/claude_enhance/"
echo "    bridge 日志:   ~/.codes/logs/"
echo ""
echo "  自测:"
echo "    cd ${CODES_DIR}/bridge && node bridge.mjs --selftest"
echo ""
echo "  防火墙:"
echo "    bridge 使用出站 WebSocket 连接飞书，无需开放入站端口"
echo "    仅需开放 SSH: sudo ufw allow ssh && sudo ufw enable"
echo ""
echo "  现在去飞书发条消息试试吧!"
echo ""
