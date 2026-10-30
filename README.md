# catalog-svc

Product catalog and stock service for the E-Commerce platform (:4020).

Features:

- Products, variants, options, images, discounts, categories, brands and badges.
- Stock as a ledger: every change writes `catalog.stock_movements`, and
  `catalog.stock_reservations` holds stock idempotently for checkout.
- Publishes `product.updated` / `category.updated` (in-memory bus in tests, Kafka
  otherwise).
- Consumes `order.created` and commits the matching hold (`cat-009`), so a paid
  order's stock is never returned to the shelf by the 900 s expiry sweep.
- Internal service-to-service API for stock levels, snapshots and reservations.

## Local setup

Prerequisites:

- Node 24
- pnpm 11
- PostgreSQL on `localhost:5433` (database `ecom`, schema `catalog`)
- Apache Kafka on `localhost:9092` (only needed for the consumer)

```bash
pnpm install --ignore-workspace
Copy-Item .env.example .env
pnpm start:dev
```

The service listens on `http://127.0.0.1:4020` and mounts everything under
`/api/v1` (`/health` is the exception).

`--ignore-workspace` matters: the root `pnpm-workspace.yaml` excludes
`catalog-svc/**`, so without the flag pnpm answers "Already up to date" and leaves
`node_modules` on whatever `@ecom/contracts` it resolved last time.

### Database Schema & Seed Setup (Manual)

Apply in order — later files assume the earlier ones exist:

```bash
psql -h localhost -p 5433 -U ecom -d ecom -f db/001-catalog-schema.sql
psql -h localhost -p 5433 -U ecom -d ecom -f db/002-seed-catalog.sql
psql -h localhost -p 5433 -U ecom -d ecom -f db/003-stock-reservations.sql
psql -h localhost -p 5433 -U ecom -d ecom -f db/004-badges-and-card-settings.sql
psql -h localhost -p 5433 -U ecom -d ecom -f db/005-product-option-card-placement.sql
psql -h localhost -p 5433 -U ecom -d ecom -f db/006-order-created-consumer.sql
```

`006` creates `catalog.processed_events`, the consumer's dedupe table. Without it
every `order.created` event fails with
`relation "catalog.processed_events" does not exist` and lands in the DLQ.

On PowerShell 5.1 there is no `<` redirection, so pipe the file instead:

```powershell
Get-Content db\006-order-created-consumer.sql -Raw | docker exec -i ecom-pg psql -U ecom -d ecom -f -
```

## API Endpoints

### Public Endpoints

- `GET /api/v1/catalog/products` — published products, filterable and paginated.
- `GET /api/v1/catalog/products/:slug` — product detail with images, options,
  variants and badges.
- `GET /api/v1/catalog/categories`, `GET /api/v1/catalog/brands`
- Admin routes for products, variants, images, discounts, categories, brands and
  badges are the same paths with a JWT and the `admin` role.

### Internal Endpoints (requires `x-service-key`)

Mounted under `/api/v1/catalog/internal` (the legacy `/api/v1/internal` prefix is
also served):

- `GET stock?productId=…&variantId=…` — current stock level.
- `POST stock/reserve` — take a hold. The caller supplies `reservationId`, which is
  also the idempotency key, so a replay returns the stored body unchanged.
- `POST stock/commit` — consume a hold. **Never moves stock**: the hold already
  decremented it and wrote the `sale` movement.
- `POST stock/release` — restore exactly the items stored on the hold.
- `GET stock/reservations/:id` — reservation state.
- `GET products?ids=a,b,c` — product snapshots for order-svc.
- `GET consumer-stats` — `{ committed, duplicate, ignored, invalid, dlq }` since
  boot.

All of them answer `401 SERVICE_KEY_INVALID` without the header and
`Cache-Control: no-store`.

## Event Consumption

`order.created` → commit the hold referenced by `payload.reservationId`.

| Setting | Value |
|---|---|
| Consumer group / client id | `catalog-svc` |
| Topics | `order.created` (`KafkaOrderConsumer.CATALOG_CONSUMER_TOPICS`) |
| Offset commit | Manual, after the side effect (and any DLQ write) succeeds |
| DLQ | `order.created.dlq` |
| Produces | Nothing |

The handler classifies first and writes second: envelope → payload → `reservationId`
→ one transaction that claims `catalog.processed_events` and commits the hold.
Idempotency is therefore double: the event id dedupes redeliveries, and the hold's
own state makes a second commit a no-op (`already-committed`).

| Outcome | Where it goes | Offset |
|---|---|---|
| body is not JSON | `order.created.dlq` (`invalid-json`) | committed |
| envelope rejected | `order.created.dlq` (`invalid-envelope`) | committed |
| payload rejected | `order.created.dlq` (`invalid-payload`) | committed |
| `reservationId: ""` (legacy order) | ignored, no row written | committed |
| event id already processed | ignored (`duplicate`) | committed |
| hold `released` / `expired` | `order.created.dlq` (`reservation-closed`) | committed |
| hold belongs to another order | `order.created.dlq` (`reservation-mismatch`) | committed |
| hold not found | retried 1/2/4/8/16 s, then `reservation-missing` | committed |
| anything else (DB down) | retried 1/2/4/8/16 s, then `transient-exhausted` | committed |

Two rules make the table safe to reason about:

1. **A DLQ write that fails keeps the offset uncommitted**, so the partition
   redelivers the record instead of losing it.
2. **`catalog.processed_events` only gets a row when the side effect was applied.**
   A terminal-but-unapplied outcome rolls the claim back, which is why the DLQ is
   the only record of a failed event.

`cat-009` is correct but *inert* until `ord-011` ships: the order-svc outbox relay
still only logs, so nothing publishes `order.created` in a real deployment yet.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4020` | |
| `DATABASE_URL` | — | Required |
| `JWT_SECRET` | — | Required, ≥ 32 chars |
| `INTERNAL_SERVICE_KEY` | — | Required for internal routes |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated |
| `KAFKA_CONSUMER_ENABLED` | `true` | `false` keeps the API up without the consumer; holds then wait for the sweep or an operator |
| `STOCK_RESERVATION_TTL_SECONDS` | `900` | Hold lifetime before the sweep releases it |

## Health Probes

- `GET /health` — liveness.
- `GET /health/ready` — readiness; checks the database.

## Quality gates

```bash
pnpm exec tsc --noEmit   # there is no `typecheck` script
pnpm lint
pnpm test                # unit tests (no database, no broker)
pnpm test:e2e            # requires the ecom database on :5433, runs sequentially
pnpm build
```

E2E tests use the shared development database and clean up their own fixtures by
id, so they must not run in parallel with another e2e suite.
