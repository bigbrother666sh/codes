> This file extends [common/testing.md](../common/testing.md) with web-specific testing content.

# Web Testing Rules

## Priority Order

1. **Visual Regression** — Screenshot key breakpoints: 320, 768, 1024, 1440
2. **Accessibility** — Keyboard navigation, reduced-motion, color contrast
3. **Performance** — Lighthouse against meaningful pages, keep CWV targets
4. **Cross-Browser** — Chrome, Firefox, Safari minimum
5. **Responsive** — Test 320, 375, 768, 1024, 1440, 1920

## E2E Shape

```ts
import { test, expect } from '@playwright/test';

test('landing hero loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
```

- Avoid flaky timeout-based assertions
- Prefer deterministic waits

## Unit Tests

- Test utilities, data transforms, and custom hooks
- Visual regression often carries more signal than brittle markup assertions for visual components
