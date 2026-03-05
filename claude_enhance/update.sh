#!/usr/bin/env bash
# Deploy Everything Claude Code to ~/.claude/
# Usage: bash claude_enhance/deploy.sh [--dry-run]
set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${HOME}/.claude"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# Commands that conflict with Claude Code native commands → rename to enhance:<name>
CONFLICTS=("plan")

log()  { echo "  $*"; }
step() { echo ""; echo "→ $*"; }
run()  {
  if $DRY_RUN; then
    printf "  [dry]"
    for arg in "$@"; do
      printf " %q" "$arg"
    done
    echo ""
  else
    "$@"
  fi
}

echo "============================================"
echo "  Everything Claude Code — Deploy Script"
echo "============================================"
echo "  Source : ${SCRIPT_DIR}"
echo "  Target : ${CLAUDE_HOME}"
$DRY_RUN && echo "  Mode   : DRY RUN (no files written)"

# ── 依赖检查 ─────────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo ""
  echo "ERROR: jq is required. Install with: brew install jq"
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo ""
  echo "WARNING: node not found — hook scripts may not work"
fi

# ── 创建目录 ─────────────────────────────────────────────────────────────────
step "Creating directories"
for dir in agents commands skills rules/common contexts scripts; do
  run mkdir -p "${CLAUDE_HOME}/${dir}"
  log "${CLAUDE_HOME}/${dir}"
done
for lang in typescript python golang; do
  [[ -d "${SCRIPT_DIR}/rules/${lang}" ]] && run mkdir -p "${CLAUDE_HOME}/rules/${lang}"
done

# ── Agents ───────────────────────────────────────────────────────────────────
step "Installing agents (${CLAUDE_HOME}/agents/)"
agent_files=("${SCRIPT_DIR}/agents/"*.md)
if (( ${#agent_files[@]} == 0 )); then
  log "No agent markdown files found; skipping."
else
  for f in "${agent_files[@]}"; do
    name="$(basename "$f")"
    run cp "$f" "${CLAUDE_HOME}/agents/${name}"
    log "${name}"
  done
fi

# ── Commands（冲突命令加 enhance: 前缀）──────────────────────────────────────
step "Installing commands (${CLAUDE_HOME}/commands/)"
command_files=("${SCRIPT_DIR}/commands/"*.md)
if (( ${#command_files[@]} == 0 )); then
  log "No command markdown files found; skipping."
else
  for f in "${command_files[@]}"; do
    name="$(basename "$f" .md)"
    dest="${name}"
    for c in "${CONFLICTS[@]}"; do
      if [[ "${name}" == "${c}" ]]; then
        dest="enhance:${name}"
        log "/${name} → /enhance:${name}  (conflicts with native command)"
        break
      fi
    done
    run cp "$f" "${CLAUDE_HOME}/commands/${dest}.md"
    [[ "${dest}" == "${name}" ]] && log "${dest}.md"
  done
fi

# ── Skills ───────────────────────────────────────────────────────────────────
step "Installing skills (${CLAUDE_HOME}/skills/)"
skill_entries=("${SCRIPT_DIR}/skills/"*)
if (( ${#skill_entries[@]} == 0 )); then
  log "No skills found; skipping."
else
  run cp -r "${skill_entries[@]}" "${CLAUDE_HOME}/skills/"
  log "$(find "${SCRIPT_DIR}/skills" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') skill directories"
fi

# ── Rules ────────────────────────────────────────────────────────────────────
step "Installing rules (${CLAUDE_HOME}/rules/)"
common_rules=("${SCRIPT_DIR}/rules/common/"*)
if (( ${#common_rules[@]} == 0 )); then
  log "No common rules found; skipping common/."
else
  run cp -r "${common_rules[@]}" "${CLAUDE_HOME}/rules/common/"
fi
for lang in typescript python golang; do
  if [[ -d "${SCRIPT_DIR}/rules/${lang}" ]]; then
    lang_rules=("${SCRIPT_DIR}/rules/${lang}/"*)
    if (( ${#lang_rules[@]} == 0 )); then
      log "${lang}/ (empty, skipped)"
    else
      run cp -r "${lang_rules[@]}" "${CLAUDE_HOME}/rules/${lang}/"
      log "${lang}/"
    fi
  fi
done
(( ${#common_rules[@]} > 0 )) && log "common/"

# ── Contexts ─────────────────────────────────────────────────────────────────
step "Installing contexts (${CLAUDE_HOME}/contexts/)"
if [[ -d "${SCRIPT_DIR}/contexts" ]]; then
  context_files=("${SCRIPT_DIR}/contexts/"*.md)
  if (( ${#context_files[@]} == 0 )); then
    log "No context markdown files found; skipping."
  else
    for f in "${context_files[@]}"; do
      run cp "$f" "${CLAUDE_HOME}/contexts/$(basename "$f")"
      log "$(basename "$f")"
    done
  fi
fi

# ── Scripts（hooks 依赖）─────────────────────────────────────────────────────
step "Installing scripts (${CLAUDE_HOME}/scripts/)"
script_entries=("${SCRIPT_DIR}/scripts/"*)
if (( ${#script_entries[@]} == 0 )); then
  log "No scripts found; skipping."
else
  run cp -r "${script_entries[@]}" "${CLAUDE_HOME}/scripts/"
  log "hooks/, lib/"
fi

# ── Hooks → settings.json ────────────────────────────────────────────────────
step "Configuring hooks in settings.json"

SETTINGS_FILE="${CLAUDE_HOME}/settings.json"
if [[ -f "${SETTINGS_FILE}" ]]; then
  if ! CURRENT_SETTINGS="$(jq -c . "${SETTINGS_FILE}" 2>/dev/null)"; then
    echo "ERROR: ${SETTINGS_FILE} is not valid JSON; aborting to avoid overwriting."
    exit 1
  fi
else
  CURRENT_SETTINGS='{}'
fi

# 处理 hooks.json：
#   1. 跳过 doc-file-warning hook（防止写入特殊 md 的那个）
#   2. 将 ${CLAUDE_PLUGIN_ROOT} 替换为 ~/.claude
PROCESSED_HOOKS="$(
  jq \
    --arg root "${CLAUDE_HOME}" \
    '
      def replace_root: gsub("\\$\\{CLAUDE_PLUGIN_ROOT\\}"; $root);

      .hooks
      | with_entries(
          .value |= map(
            select(.description | ascii_downcase | test("doc file warning") | not)
            | .hooks |= map(.command |= replace_root)
          )
        )
    ' "${SCRIPT_DIR}/hooks/hooks.json"
)"

# 合并到 settings.json：保留 model/language/effortLevel，移除 enabledPlugins，写入 hooks
# 若用户尚未设置 model/effortLevel，写入推荐默认值
NEW_SETTINGS="$(
  echo "${CURRENT_SETTINGS}" \
  | jq \
      --argjson hooks "${PROCESSED_HOOKS}" \
      '
        del(.enabledPlugins)
        | .model //= "sonnet"
        | .effortLevel //= "high"
        | . + {"hooks": $hooks}
      '
)"

if $DRY_RUN; then
  log "[dry] Would write settings.json"
  log "Hooks to install:"
  echo "${PROCESSED_HOOKS}" | jq 'keys'
else
  if [[ -f "${SETTINGS_FILE}" ]]; then
    backup_file="${SETTINGS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp "${SETTINGS_FILE}" "${backup_file}"
    log "Backup: ${backup_file}"
  fi
  echo "${NEW_SETTINGS}" > "${SETTINGS_FILE}"
  log "Written: ${SETTINGS_FILE}"
  log "Hook types: $(echo "${PROCESSED_HOOKS}" | jq -r 'keys | join(", ")')"
fi

# ── 完成 ─────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Deploy complete"
echo "============================================"
if ! $DRY_RUN; then
  echo "  agents   : $(ls "${CLAUDE_HOME}/agents/"*.md 2>/dev/null | wc -l | tr -d ' ')"
  echo "  commands : $(ls "${CLAUDE_HOME}/commands/"*.md 2>/dev/null | wc -l | tr -d ' ')"
  echo "  skills   : $(ls -d "${CLAUDE_HOME}/skills/"*/ 2>/dev/null | wc -l | tr -d ' ')"
  echo ""
  echo "  Restart Claude Code for changes to take effect."
fi
