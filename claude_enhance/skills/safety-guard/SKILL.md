---
name: safety-guard
description: Use this skill to prevent destructive operations when working on production systems or running agents autonomously.
origin: ECC
---

# Safety Guard — Prevent Destructive Operations

## When to Use

- When working on production systems
- When agents run autonomously (full-auto mode)
- When restricting edits to a specific directory
- During sensitive operations (migrations, deploys, data changes)

## Three Modes

### Mode 1: Careful Mode

Intercepts and warns on destructive commands:

```
rm -rf (especially /, ~, project root)
git push --force / git reset --hard
DROP TABLE / DROP DATABASE
docker system prune / kubectl delete
chmod 777 / sudo rm
npm publish / any --no-verify command
```

### Mode 2: Freeze Mode

Locks file edits to a specific directory:

```
/safety-guard freeze src/components/
```

Any Write/Edit outside that path is blocked.

### Mode 3: Guard Mode (Careful + Freeze combined)

```
/safety-guard guard --dir src/api/ --allow-read-all
```

Agents can read anything but only write to `src/api/`.

### Unlock

```
/safety-guard off
```

## Implementation

Uses PreToolUse hooks to intercept Bash, Write, Edit, and MultiEdit calls.
Logs all blocked actions to `~/.claude/safety-guard.log`.
