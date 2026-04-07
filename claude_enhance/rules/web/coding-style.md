> This file extends [common/coding-style.md](../common/coding-style.md) with web-specific frontend content.

# Web Coding Style

## File Organization

Organize by feature or surface area, not by file type:

```text
src/
├── components/
│   ├── hero/
│   │   ├── Hero.tsx
│   │   ├── HeroVisual.tsx
│   │   └── hero.css
│   └── ui/
│       ├── Button.tsx
│       └── AnimatedText.tsx
├── hooks/
│   └── useScrollProgress.ts
├── lib/
│   └── animation.ts
└── styles/
    ├── tokens.css
    └── global.css
```

## CSS Custom Properties

Define design tokens as variables:

```css
:root {
  --color-surface: oklch(98% 0 0);
  --color-text: oklch(18% 0 0);
  --color-accent: oklch(68% 0.21 250);
  --text-hero: clamp(3rem, 1rem + 7vw, 8rem);
  --space-section: clamp(4rem, 3rem + 5vw, 10rem);
  --duration-normal: 300ms;
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}
```

## Animation-Only Properties

Prefer compositor-friendly: `transform`, `opacity`, `clip-path`.
Avoid animating: `width`, `height`, `top`, `left`, `margin`, `padding`.

## Semantic HTML First

Use `<header>`, `<main>`, `<section aria-labelledby>`, `<footer>` — not generic `div` stacks.

## Naming

- Components: PascalCase (`ScrollySection`)
- Hooks: `use` prefix (`useReducedMotion`)
- CSS classes: kebab-case
