---
name: hexagonal-architecture
description: Design, implement, and refactor Ports & Adapters systems with clear domain boundaries, dependency inversion, and testable use-case orchestration across TypeScript, Java, Kotlin, and Go services.
origin: ECC
---

# Hexagonal Architecture

Keeps business logic independent from frameworks, transport, and persistence. The core app depends on abstract ports; adapters implement those ports at the edges.

## When to Use

- Building new features where long-term maintainability and testability matter
- Refactoring tightly coupled code where domain logic mixes with I/O
- Supporting multiple interfaces (HTTP, CLI, queue workers, cron) for the same use case
- Replacing infrastructure (DB, APIs) without rewriting business rules

## Core Concepts

- **Domain model**: Business rules and entities. No framework imports.
- **Use cases**: Orchestrate domain behavior and workflow steps.
- **Inbound ports**: Contracts for what the app can do.
- **Outbound ports**: Contracts for dependencies (repositories, gateways, event publishers).
- **Adapters**: Infrastructure implementations of ports.
- **Composition root**: Single wiring location where concrete adapters bind to use cases.

Dependency direction is always inward: Adapters → Application/Domain.

## TypeScript Example

```typescript
// Port
export interface OrderRepositoryPort {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
}

// Use case
export class CreateOrderUseCase {
  constructor(
    private readonly orderRepository: OrderRepositoryPort,
    private readonly paymentGateway: PaymentGatewayPort
  ) {}

  async execute(input: CreateOrderInput): Promise<CreateOrderOutput> {
    const order = Order.create(input);
    const auth = await this.paymentGateway.authorize(order);
    await this.orderRepository.save(order.markAuthorized(auth.id));
    return { orderId: order.id, authorizationId: auth.id };
  }
}

// Composition root
export const buildUseCase = (deps: { db: SqlClient; stripe: StripeClient }) =>
  new CreateOrderUseCase(
    new PostgresOrderRepository(deps.db),
    new StripePaymentGateway(deps.stripe)
  );
```

## Anti-Patterns

- Domain entities importing ORM models or web framework types
- Use cases reading from `req`/`res` directly
- Returning DB rows from use cases without domain mapping
- Spreading dependency wiring across many files
