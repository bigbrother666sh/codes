#!/usr/bin/env bash
# ============================================================================
# Feishu-Claude Bridge — 配置备份脚本
#
# 用法:
#   ./backup.sh <ssh_target> [backup_root]
# 示例:
#   ./backup.sh incu
#   ./backup.sh wukong@123.60.18.144 ./backups
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
fatal() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  ./backup.sh <ssh_target> [backup_root]

Description:
  从远端服务器下载以下内容到本地：
  - ~/.codes     (排除 logs/ 与 bridge-sessions.json)
  - ~/.claude.json
  - ~/.claude/settings.json
  - ~/.claude/projects/*/memory

Arguments:
  ssh_target   SSH 目标（如 incu 或 user@host）
  backup_root  本地备份根目录（默认: ./backups）
EOF
}

require_command() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fatal "缺少命令: $cmd"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

REMOTE_TARGET="$1"
BACKUP_ROOT="${2:-./backups}"

require_command ssh
require_command tar
require_command find
require_command sed

mkdir -p "$BACKUP_ROOT"
BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"

TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
SAFE_TARGET="$(echo "$REMOTE_TARGET" | sed 's/[^A-Za-z0-9._-]/_/g')"
SNAPSHOT_DIR="${BACKUP_ROOT}/${SAFE_TARGET}_${TIMESTAMP}"

mkdir -p "$SNAPSHOT_DIR"

info "开始备份远端: ${REMOTE_TARGET}"
info "本地目录: ${SNAPSHOT_DIR}"

ssh "$REMOTE_TARGET" 'bash -s' <<'REMOTE_SCRIPT' | tar -xzf - -C "$SNAPSHOT_DIR"
set -euo pipefail

home="$HOME"
declare -a targets=()

if [[ -e "$home/.codes" ]]; then
  targets+=(".codes")
fi

if [[ -f "$home/.claude.json" ]]; then
  targets+=(".claude.json")
fi

if [[ -f "$home/.claude/settings.json" ]]; then
  targets+=(".claude/settings.json")
fi

if [[ -d "$home/.claude/projects" ]]; then
  while IFS= read -r memory_dir; do
    rel_path="${memory_dir#"$home/"}"
    targets+=("$rel_path")
  done < <(find "$home/.claude/projects" -mindepth 2 -maxdepth 2 -type d -name memory -print | sort)
fi

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "远端未找到可备份内容: $home" >&2
  exit 44
fi

tar -C "$home" \
  --exclude='.codes/logs' \
  --exclude='.codes/logs/*' \
  --exclude='.codes/bridge-sessions.json' \
  -czf - "${targets[@]}"
REMOTE_SCRIPT

FILE_COUNT="$(find "$SNAPSHOT_DIR" -type f | wc -l | tr -d ' ')"
DIR_COUNT="$(find "$SNAPSHOT_DIR" -type d | wc -l | tr -d ' ')"

ok "备份完成"
echo "  路径: ${SNAPSHOT_DIR}"
echo "  文件数: ${FILE_COUNT}"
echo "  目录数: ${DIR_COUNT}"
