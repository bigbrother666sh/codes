---
name: product-lens
description: Use this skill to validate the "why" before building, run product diagnostics, and pressure-test product direction before the request becomes an implementation contract.
origin: ECC
---

# Product Lens — Think Before You Build

Owns product diagnosis, not implementation-ready specification writing.
If you need a durable PRD-to-SRS artifact, hand off to `product-capability`.

## When to Use

- Before starting any feature — validate the "why"
- When stuck choosing between features
- Before a launch — sanity check the user journey
- Converting a vague idea into a product brief before engineering planning

## Four Modes

### Mode 1: Product Diagnostic
Asks the hard questions:
1. Who is this for? (specific person, not "developers")
2. What's the pain? (quantify: how often, how bad)
3. Why now?
4. What's the 10-star version?
5. What's the MVP?
6. What's the anti-goal?
7. How do you know it's working? (metric, not vibes)

Output: `PRODUCT-BRIEF.md` with answers, risks, go/no-go recommendation.

### Mode 2: Founder Review
Reviews current project through a founder lens:
- Infer what this is trying to be
- Score product-market fit signals (0-10)
- Identify the one thing that would 10x this
- Flag things being built that don't matter

### Mode 3: User Journey Audit
Maps the actual user experience, times each step, scores time-to-value.

### Mode 4: Feature Prioritization
ICE score (Impact × Confidence ÷ Effort), apply constraints, output prioritized roadmap.
