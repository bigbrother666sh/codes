---
name: hookify-rules
description: This skill should be used when the user asks to create a hookify rule, write a hook rule, configure hookify, add a hookify rule, or needs guidance on hookify rule syntax and patterns.
---

# Writing Hookify Rules

Hookify rules are markdown files with YAML frontmatter that define patterns to watch for and messages to show when those patterns match. Store in `.claude/hookify.{rule-name}.local.md`.

## Rule File Format

```markdown
---
name: rule-identifier
enabled: true
event: bash|file|stop|prompt|all
pattern: regex-pattern-here
---

Message to show Claude when this rule triggers.
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| name | Yes | Unique kebab-case identifier (verb-first: warn-*, block-*, require-*) |
| enabled | Yes | true/false to toggle |
| event | Yes | bash/file/stop/prompt/all |
| action | No | warn (default) or block |
| pattern | Yes | Regex string to match |

## Advanced: Multiple Conditions

```markdown
---
name: warn-env-api-keys
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.env$
  - field: new_text
    operator: contains
    pattern: API_KEY
---
You're adding an API key to a .env file. Ensure this file is in .gitignore!
```

## Event Type Guide

- **bash**: Match commands (dangerous: `rm\s+-rf`, `chmod\s+777`)
- **file**: Match Edit/Write operations (debug code, sensitive files)
- **stop**: Completion checks (pattern `.*` always matches)
- **prompt**: Match user prompt content

## File Organization

- Location: `.claude/` in project root
- Naming: `.claude/hookify.{name}.local.md`
- Add `.claude/*.local.md` to `.gitignore`
