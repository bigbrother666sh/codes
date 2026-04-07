> This file extends [common/hooks.md](../common/hooks.md) with web-specific hook recommendations.

# Web Hooks

## Recommended PostToolUse Hooks

### Format on Save

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "command": "pnpm prettier --write \"$FILE_PATH\"",
      "description": "Format edited frontend files"
    }]
  }
}
```

### Lint Check

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "command": "pnpm eslint --fix \"$FILE_PATH\"",
      "description": "Run ESLint on edited frontend files"
    }]
  }
}
```

### Type Check

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "command": "pnpm tsc --noEmit --pretty false",
      "description": "Type-check after frontend edits"
    }]
  }
}
```

## Stop Hooks

### Final Build Verification

```json
{
  "hooks": {
    "Stop": [{
      "command": "pnpm build",
      "description": "Verify the production build at session end"
    }]
  }
}
```

## Ordering

1. format → 2. lint → 3. type check → 4. build verification
