> This file extends [common/performance.md](../common/performance.md) with web-specific performance content.

# Web Performance Rules

## Core Web Vitals Targets

| Metric | Target |
|--------|--------|
| LCP | < 2.5s |
| INP | < 200ms |
| CLS | < 0.1 |
| FCP | < 1.5s |
| TBT | < 200ms |

## Bundle Budget

| Page Type | JS Budget (gzipped) | CSS Budget |
|-----------|---------------------|------------|
| Landing page | < 150kb | < 30kb |
| App page | < 300kb | < 50kb |

## Loading Strategy

1. Inline critical above-the-fold CSS where justified
2. Preload the hero image and primary font only
3. Defer non-critical CSS or JS
4. Dynamically import heavy libraries

## Image Optimization

- Explicit `width` and `height`
- `loading="eager"` + `fetchpriority="high"` for hero media only
- `loading="lazy"` for below-the-fold assets
- Prefer AVIF or WebP with fallbacks

## Performance Checklist

- [ ] All images have explicit dimensions
- [ ] No accidental render-blocking resources
- [ ] No layout shifts from dynamic content
- [ ] Motion stays on compositor-friendly properties
