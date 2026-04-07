---
name: product-capability
description: Translate PRD intent, roadmap asks, or product discussions into an implementation-ready capability plan that exposes constraints, invariants, interfaces, and unresolved decisions before multi-service work starts.
origin: ECC
---

# Product Capability

Turns product intent into explicit engineering constraints.

## When to Use

- PRD exists but implementation constraints are still implicit
- Feature crosses multiple services/repos and needs a capability contract before coding
- Senior engineers keep restating the same hidden assumptions during review
- Need a reusable artifact that survives across sessions

## Core Workflow

### 1. Restate the capability
One precise statement: who, what new capability, what outcome changes.

### 2. Resolve capability constraints
- Business rules, scope boundaries, invariants
- Trust boundaries, data ownership, lifecycle transitions
- Rollout/migration requirements, failure/recovery expectations

### 3. Define the implementation-facing contract
- Capability summary and explicit non-goals
- Actors and surfaces, required states and transitions
- Interfaces/inputs/outputs, data model implications
- Security/billing/policy constraints, open questions

### 4. Translate into execution
- Ready for direct implementation
- Needs architecture review first
- Needs product clarification first

## Output Format

```text
CAPABILITY / CONSTRAINTS / IMPLEMENTATION CONTRACT / NON-GOALS / OPEN QUESTIONS / HANDOFF
```

## Rules

- Do not invent product truth — mark unresolved questions explicitly
- Separate user-visible promises from implementation details
- If the request conflicts with existing repo constraints, say so clearly
