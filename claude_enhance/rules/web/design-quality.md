> This file extends [common/patterns.md](../common/patterns.md) with web-specific design-quality guidance.

# Web Design Quality Standards

## Anti-Template Policy

Do not ship generic template-looking UI. Frontend output should look intentional, opinionated, and specific to the product.

### Banned Patterns

- Default card grids with uniform spacing and no hierarchy
- Stock hero section with centered headline, gradient blob, and generic CTA
- Unmodified library defaults passed off as finished design
- Safe gray-on-white styling with one decorative accent color
- Uniform radius, spacing, and shadows across every component

### Required Qualities

Every meaningful frontend surface should demonstrate at least four of these:

1. Clear hierarchy through scale contrast
2. Intentional rhythm in spacing, not uniform padding everywhere
3. Depth or layering through overlap, shadows, surfaces, or motion
4. Typography with character and a real pairing strategy
5. Color used semantically, not just decoratively
6. Hover, focus, and active states that feel designed
7. Motion that clarifies flow instead of distracting from it

## Before Writing Frontend Code

1. Pick a specific style direction. Avoid vague defaults like "clean minimal".
2. Define a palette intentionally.
3. Choose typography deliberately.

## Component Checklist

- [ ] Does it avoid looking like a default Tailwind or shadcn template?
- [ ] Does it have intentional hover/focus/active states?
- [ ] Would this look believable in a real product screenshot?
