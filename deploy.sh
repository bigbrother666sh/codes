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
info "Phase 1/5: 安装系统依赖..."

sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq > /dev/null 2>&1
ok "系统依赖已安装"

# ─── Phase 2: Node.js ────────────────────────────────────────────
info "Phase 2/5: 安装 Node.js ${NODE_MAJOR}.x..."

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
info "Phase 3/5: 安装 Claude Code CLI..."

if command -v claude &>/dev/null; then
  ok "Claude Code 已安装: $(claude --version 2>/dev/null || echo 'unknown')"
else
  npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
  ok "Claude Code $(claude --version 2>/dev/null || echo '') 已安装"
fi

# ─── Phase 4: 克隆仓库 + 安装依赖 ────────────────────────────────
info "Phase 4/5: 克隆仓库并安装依赖..."

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
info "Phase 5/5: 配置..."

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

# 写入环境变量（幂等）
if ! grep -q 'ANTHROPIC_BASE_URL' "$HOME/.profile" 2>/dev/null; then
  {
    echo ""
    echo "# Claude Code API"
    echo "export ANTHROPIC_BASE_URL=\"${ANTHROPIC_BASE_URL}\""
    echo "export ANTHROPIC_API_KEY=\"${ANTHROPIC_AUTH_TOKEN}\""
  } >> "$HOME/.profile"
  ok "API 环境变量已写入 ~/.profile"
fi

# ─── 创建 systemd 服务 ───────────────────────────────────────────
info "创建 systemd 服务..."

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
