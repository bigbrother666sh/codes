> This file extends [common/patterns.md](../common/patterns.md) with web-specific patterns.

# Web Patterns

## Component Composition

### Compound Components

Use compound components when related UI shares state:

```tsx
<Tabs defaultValue="overview">
  <Tabs.List>
    <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="overview">...</Tabs.Content>
</Tabs>
```

### Container / Presentational Split

- Container components own data loading and side effects
- Presentational components receive props and render UI (keep pure)

## State Management

| Concern | Tooling |
|---------|---------|
| Server state | TanStack Query, SWR, tRPC |
| Client state | Zustand, Jotai, signals |
| URL state | search params, route segments |
| Form state | React Hook Form |

- Do not duplicate server state into client stores
- Persist shareable state (filters, sort, pagination) in the URL

## Data Fetching

### Optimistic Updates

- Snapshot current state → apply optimistic update → roll back on failure → emit visible error

### Parallel Loading

- Fetch independent data in parallel
- Avoid parent-child request waterfalls
