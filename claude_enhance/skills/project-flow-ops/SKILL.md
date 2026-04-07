---
name: project-flow-ops
description: Operate execution flow across GitHub and Linear by triaging issues and pull requests, linking active work, and keeping GitHub public-facing while Linear remains the internal execution layer.
origin: ECC
---

# Project Flow Ops

Turns disconnected GitHub issues, PRs, and Linear tasks into one execution flow.

## Operating Model

- **GitHub**: public and community truth
- **Linear**: internal execution truth for active scheduled work
- Not every GitHub issue needs a Linear issue — create Linear only for active/delegated/scheduled/cross-functional work

## Classification States

| State | Meaning |
|-------|---------|
| Merge | self-contained, policy-compliant, ready |
| Port/Rebuild | useful idea, manually re-land inside ECC |
| Close | wrong direction, stale, unsafe, or duplicated |
| Park | potentially useful, not scheduled now |

## Review Rules

- Never merge from title/summary alone; use full diff
- CI red = classify and fix or block; do not pretend merge-ready
- External-source features should be rebuilt internally when valuable but not self-contained

## Output Format

```text
PUBLIC STATUS / CLASSIFICATION / LINEAR ACTION / NEXT OPERATOR ACTION
```
