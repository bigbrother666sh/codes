---
name: terminal-ops
description: Evidence-first repo execution workflow for ECC. Use when the user wants a command run, a repo checked, a CI failure debugged, or a narrow fix pushed with exact proof of what was executed and verified.
origin: ECC
---

# Terminal Ops

Use when the user wants real repo execution: run commands, inspect git state, debug CI/builds, make a narrow fix, and report exactly what changed and what was verified.

## When to Use

- User says "fix", "debug", "run this", "check the repo", or "push it"
- Task depends on command output, git state, test results, or a verified local fix
- Answer must distinguish: changed locally / verified locally / committed / pushed

## Guardrails

- Inspect before editing
- Stay read-only if user asked for audit/review only
- Prefer repo-local scripts over improvised wrappers
- Do not claim "fixed" until the proving command was rerun
- Do not claim "pushed" unless the branch actually moved upstream

## Workflow

1. **Resolve the working surface**: repo path, branch, local diff state, requested mode
2. **Read the failing surface first**: inspect error, file/test, git state before changing
3. **Keep the fix narrow**: solve one dominant failure at a time
4. **Report exact execution state**: inspected / changed locally / verified locally / committed / pushed / blocked

## Output Format

```text
SURFACE
- repo, branch, requested mode

EVIDENCE
- failing command / diff / test

ACTION
- what changed

STATUS
- inspected / changed locally / verified locally / committed / pushed / blocked
```
