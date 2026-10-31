import { Global, Module } from '@nestjs/common';
import { createOutboxModule } from '@ecom/messaging/nest';
import { getPool } from '../db/pool.js';
import { CatalogOutbox } from './catalog-outbox.js';

/**
 * Owns `catalog.outbox` and everything the relay needs to drain it.
 *
 * Everything except the schema name lives in `@ecom/messaging`: claim SQL,
 * leases, backoff, the envelope and the Kafka publisher. Global because the
 * three producer modules (products, categories, badges) each inject
 * `CatalogOutbox`, and registering the store twice would create two relays.
 */
@Global()
@Module({
  imports: [
    createOutboxModule({
      schema: 'catalog',
      producer: 'catalog-svc',
      clientId: 'catalog-svc',
      pool: getPool,
    }),
  ],
  providers: [CatalogOutbox],
  exports: [CatalogOutbox],
})
export class CatalogOutboxModule {}
