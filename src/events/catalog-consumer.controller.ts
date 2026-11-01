import { Controller } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  Payload,
  type KafkaContext,
} from '@nestjs/microservices';
import { KafkaEventHandler } from '@ecom/messaging/nest';
import type { KafkaHandlerOutcome } from '@ecom/messaging';
import type { CatalogTopic } from './catalog-topics.js';
import {
  toOrderCreatedOutcome,
  toProductImportedOutcome,
} from './handler-outcome.js';
import { OrderCreatedHandler } from './order-created/order-created.handler.js';
import { ProductImportedHandler } from './product-imported/product-imported.handler.js';

/**
 * The Kafka entry point for catalog-svc.
 *
 * One controller, one consumer, one commit protocol: each `@EventPattern`
 * string is a topic the single `ServerKafka` strategy subscribes to, so a new
 * topic (`cat-010`'s `order.status.updated`) is one method here plus one entry in
 * `CATALOG_CONSUMER_TOPICS` — never a second consumer group, because two
 * consumers in one group split the partitions between them.
 *
 * What lives here is only the topic list and the mapping to the two handlers.
 * Parsing, the retry ladder, the dead letters, the counters and the offset
 * commit all belong to `KafkaEventHandler`, which is shared with cart-svc and
 * search-svc and is the only place that protocol is written down. This replaces
 * `cat-007`'s hand-written `KafkaOrderConsumer`; `OrderCreatedHandler` itself is
 * unchanged.
 *
 * **`@Payload()` and `@Ctx()` are load-bearing.** A handler that declares no
 * parameter decorator is called with the payload only: `RpcContextCreator` falls
 * back to `DEFAULT_CALLBACK_METADATA`, which is a single `PAYLOAD` at index 0,
 * so a second positional parameter would be `undefined` and every commit would
 * fail on `ctx.getMessage()`. `ctx` is typed `unknown` for two independent
 * reasons: Nest 12's `@EventPattern` overload declares the trailing handler
 * parameter that way, and `unknown` compiles to `Object` in
 * `design:paramtypes`, which is the one thing that keeps the global
 * `ValidationPipe` from rebuilding the context through `class-transformer` —
 * `ValidationPipe#toValidate` skips `String` and `Object` and nothing else. The
 * context is asserted once, in `handle`.
 */
@Controller()
export class CatalogConsumerController {
  constructor(
    private readonly events: KafkaEventHandler,
    private readonly orders: OrderCreatedHandler,
    private readonly imports: ProductImportedHandler,
  ) {}

  @EventPattern('order.created')
  async onOrderCreated(
    @Payload() raw: string,
    @Ctx() ctx: unknown,
  ): Promise<void> {
    await this.handle('order.created', raw, ctx, async (envelope) =>
      toOrderCreatedOutcome(await this.orders.handle(envelope)),
    );
  }

  @EventPattern('product.imported')
  async onProductImported(
    @Payload() raw: string,
    @Ctx() ctx: unknown,
  ): Promise<void> {
    await this.handle('product.imported', raw, ctx, async (envelope) =>
      toProductImportedOutcome(await this.imports.handle(envelope)),
    );
  }

  /**
   * `topic` is passed explicitly rather than read from the context so a
   * mistyped `@EventPattern` produces a wrong DLQ name in the tests instead of
   * quietly going to the right place.
   */
  private async handle(
    topic: CatalogTopic,
    raw: string,
    ctx: unknown,
    translate: (envelope: unknown) => Promise<KafkaHandlerOutcome>,
  ): Promise<void> {
    await this.events.run(ctx as KafkaContext, topic, raw, translate);
  }
}
