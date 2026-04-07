---
name: security-bounty-hunter
description: Hunt for exploitable, bounty-worthy security issues in repositories. Focuses on remotely reachable vulnerabilities that qualify for real reports instead of noisy local-only findings.
origin: ECC
---

# Security Bounty Hunter

Use when the goal is practical vulnerability discovery for responsible disclosure or bounty submission.

## In-Scope Patterns

| Pattern | CWE | Typical Impact |
|---------|-----|----------------|
| SSRF through user-controlled URLs | CWE-918 | internal network access, metadata theft |
| Auth bypass in middleware/API guards | CWE-287 | unauthorized access |
| Remote deserialization / upload-to-RCE | CWE-502 | code execution |
| SQL injection in reachable endpoints | CWE-89 | data exfiltration |
| Command injection in request handlers | CWE-78 | code execution |
| Path traversal in file-serving paths | CWE-22 | arbitrary file read/write |
| Auto-triggered XSS | CWE-79 | session theft |

## Skip These (usually out of scope)

- Local-only `pickle.loads` with no remote path
- `shell=True` on fully hardcoded commands
- Missing security headers by themselves
- Self-XSS requiring victim to paste code
- Demo/example/test-only code

## Workflow

1. Check scope: program rules, SECURITY.md, exclusions
2. Find real entrypoints: HTTP handlers, uploads, webhooks, parsers
3. Read the real code path end to end
4. Prove user control reaches a meaningful sink
5. Confirm exploitability with smallest safe PoC
6. Check for duplicates before drafting report

## Report Structure

```markdown
## Description
## Vulnerable Code
[File path, line range, snippet]
## Proof of Concept
[Minimal working request or script]
## Impact
## Affected Version
```

## Quality Gate

Before submitting: code path is reachable, input is user-controlled, sink is exploitable, PoC works, not a duplicate, target is in scope.
