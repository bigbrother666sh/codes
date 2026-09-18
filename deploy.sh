#!/usr/bin/env bash
# ============================================================================
# Feishu-Codex Bridge — Ubuntu 24.04 一键部署脚本
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
NODE_MAJOR=24
CODES_REPO="https://github.com/bigbrother666sh/codes.git"
CODES_DIR="$HOME/codes"

# ─── 检测环境 ─────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Feishu-Codex Bridge 一键部署"
echo "  目标: Ubuntu 24.04"
echo "============================================"
echo ""

if [ "$(id -u)" = "0" ]; then
  warn "检测到 root 用户运行。建议使用普通用户 + sudo。"
  echo ""
fi

# ─── Phase 1: 系统依赖 ────────────────────────────────────────────
info "Phase 1/6: 安装系统依赖..."

sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq tmux bubblewrap > /dev/null 2>&1
ok "系统依赖已安装"

# ─── Phase 2: Node.js ────────────────────────────────────────────
info "Phase 2/6: 安装 Node.js ${NODE_MAJOR}.x..."

if command -v node &>/dev/null; then
  ok "Node.js 已安装: $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - > /dev/null 2>&1
  sudo apt-get install -y -qq nodejs > /dev/null 2>&1
  ok "Node.js $(node --version) 已安装"
fi

# 配置 npm 用户级全局目录（使 codex 命令在 PATH 中可用）
NPM_GLOBAL="$HOME/.npm-global"
mkdir -p "$NPM_GLOBAL"
npm config set prefix "$NPM_GLOBAL"

if ! grep -q '.npm-global/bin' "$HOME/.profile" 2>/dev/null; then
  echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> "$HOME/.profile"
fi
export PATH="$NPM_GLOBAL/bin:$PATH"

# ─── Phase 3: Codex CLI ──────────────────────────────────────────
info "Phase 3/6: 安装 Codex CLI..."

# 注意: 只检查 codex 在 PATH 不够 —— npm 缓存损坏时 optional 平台二进制包
# (@openai/codex-linux-x64) 会被静默跳过，wrapper 存在但运行即报错。
# 必须用 codex --version 验证真实可用性，失败则清缓存重装。
if command -v codex &>/dev/null && codex --version &>/dev/null; then
  ok "Codex 已安装: $(codex --version)"
else
  if ! npm install -g @openai/codex > /dev/null 2>&1 || ! codex --version &>/dev/null; then
    warn "Codex 安装异常（常见原因: npm 缓存损坏导致平台二进制包被静默跳过），清理缓存后重试..."
    npm cache clean --force > /dev/null 2>&1
    npm install -g @openai/codex
  fi
  codex --version &>/dev/null || fatal "Codex 安装后校验失败，请手动执行: npm cache clean --force && npm install -g @openai/codex@latest"
  ok "Codex $(codex --version) 已安装"
fi
CODEX_BIN="$(command -v codex)"

# ─── Phase 4: 克隆仓库 + 安装依赖 ────────────────────────────────
info "Phase 4/6: 克隆仓库并安装依赖..."

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
info "Phase 5/6: 配置..."

echo ""
echo "============================================"
echo "  现在需要你提供几个配置值"
echo "============================================"
echo ""

# --- 模型端点配置（OpenAI Responses 兼容） ---
echo -e "${BLUE}[1/3] 模型端点配置（OpenAI Responses 兼容）${NC}"
echo "  需要一个提供 /responses 端点的模型服务，例如:"
echo "    - 阿里云百炼兼容模式: https://dashscope.aliyuncs.com/compatible-mode/v1"
echo "    - 各类 OpenAI 兼容网关的 /v1 路径"
read -rp "  Base URL (如 https://xxx/compatible-mode/v1): " MODEL_BASE_URL
[ -n "$MODEL_BASE_URL" ] || fatal "Base URL 不能为空"
MODEL_API_KEY=""
read -rsp "  API Key: " MODEL_API_KEY || true
echo ""
[ -n "$MODEL_API_KEY" ] || fatal "API Key 不能为空"
read -rp "  默认模型名 (如 glm-5.2 / qwen3.8-max) [glm-5.2]: " MODEL_NAME
MODEL_NAME=${MODEL_NAME:-glm-5.2}

# --- 飞书配置 ---
echo ""
echo -e "${BLUE}[2/3] 飞书配置${NC}"
read -rp "  飞书 App ID (cli_xxx): " FEISHU_APP_ID
FEISHU_APP_SECRET=""
read -rsp "  飞书 App Secret: " FEISHU_APP_SECRET || true
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

# ─── 写入配置 ─────────────────────────────────────────────────────
mkdir -p "$HOME/.codes/secrets"
mkdir -p "$HOME/.codes/logs"

# 飞书 secret
echo -n "$FEISHU_APP_SECRET" > "$HOME/.codes/secrets/${PROJECT_ALIAS}_secret"
chmod 600 "$HOME/.codes/secrets/${PROJECT_ALIAS}_secret"
ok "飞书 secret 已写入"

# 模型 API key（bridge 启动时自动加载）
echo "CODEX_API_KEY=${MODEL_API_KEY}" > "$CODES_DIR/bridge/.env"
chmod 600 "$CODES_DIR/bridge/.env"
ok "模型 API key 已写入 bridge/.env"

# bridge.json（providers + codexDefaults 由 bridge 生成为 ~/.codes/codex-home/config.toml）
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
  "providers": {
    "default": {
      "name": "default",
      "baseUrl": "${MODEL_BASE_URL}",
      "envKey": "CODEX_API_KEY",
      "wireApi": "responses"
    }
  },
  "codexDefaults": {
    "model": "${MODEL_NAME}",
    "provider": "default"
  },
  "codexPath": "${CODEX_BIN}",
  "debug": false
}
BRIDGEEOF
chmod 600 "$HOME/.codes/bridge.json"
ok "bridge.json 已写入: ~/.codes/bridge.json"

# ─── Phase 6: 创建 systemd 服务 ──────────────────────────────────
info "Phase 6/6: 创建 systemd 服务..."

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
echo "    模型 API key:  ${CODES_DIR}/bridge/.env"
echo "    Codex home:    ~/.codes/codex-home/ (bridge 生成的 config + 会话 + 记忆)"
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
