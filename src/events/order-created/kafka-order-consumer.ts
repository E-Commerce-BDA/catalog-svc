import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { dlqTopicName, isEventTopic } from '@ecom/contracts';
import { Kafka, Partitioners, type Consumer, type Producer } from 'kafkajs';
import {
  ReservationClosedError,
  ReservationMismatchError,
} from '../../stock/stock-reservations.errors.js';
import { ConsumerMetrics, recordOutcome } from '../consumer-metrics.js';
import {
  OrderCreatedHandler,
  type OrderCreatedOutcome,
} from './order-created.handler.js';

/** Topics this consumer subscribes to. `cat-010` adds `order.status.updated`. */
export const CATALOG_CONSUMER_TOPICS = ['order.created'] as const;

export interface KafkaOrderConsumerOptions {
  brokers?: string[];
  clientId?: string;
  groupId?: string;
  retryDelaysMs?: number[];
  maxRetries?: number;
}

/**
 * Why a record left the main topic. Kept as an enum-like union so the DLQ is
 * queryable and an operator can tell "we cannot read this" from "the state
 * disagrees" without opening the payload.
 */
export type DlqReason =
  | 'invalid-json'
  | 'invalid-envelope'
  | 'invalid-payload'
  | 'reservation-closed'
  | 'reservation-mismatch'
  | 'reservation-missing'
  | 'transient-exhausted';

interface DlqRecord {
  reason: DlqReason;
  error: string;
  /** Present for `invalid-json`, where there is no parsed envelope to keep. */
  rawValue?: string;
  /** Present when the body parsed but was rejected or failed downstream. */
  originalPayload?: unknown;
}

type RouteHandler = (raw: unknown) => Promise<OrderCreatedOutcome>;

/**
 * One consumer, one commit protocol, one place to add the next topic.
 *
 * The ordering rule is the same everywhere: **side effect first, counter
 * second, offset last**. A record whose DLQ write fails keeps its offset
 * uncommitted, so the partition redelivers it instead of losing it silently.
 */
@Injectable()
export class KafkaOrderConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaOrderConsumer.name);
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  private readonly metrics: ConsumerMetrics;
  private readonly routes: Record<string, RouteHandler>;
  private readonly retryDelaysMs: number[];
  private readonly maxRetries: number;
  private isRunning = false;
  private connectRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly handler: OrderCreatedHandler,
    private readonly configService: ConfigService,
    @Optional() metrics?: ConsumerMetrics,
    @Optional()
    @Inject('KAFKA_CONSUMER_OPTIONS')
    options?: KafkaOrderConsumerOptions,
  ) {
    this.metrics = metrics ?? new ConsumerMetrics();

    const brokers =
      options?.brokers ??
      (this.configService.get<string>('KAFKA_BROKERS', 'localhost:9092') ?? '')
        .split(',')
        .map((broker) => broker.trim())
        .filter(Boolean);

    this.retryDelaysMs = options?.retryDelaysMs ?? [
      1000, 2000, 4000, 8000, 16000,
    ];
    this.maxRetries = options?.maxRetries ?? 5;

    // Adding `cat-010`'s topic is one more key here, not a second consumer:
    // two consumers in one group would split the partitions between them.
    this.routes = {
      'order.created': (raw) => this.handler.handle(raw),
    };

    this.kafka = new Kafka({
      clientId: options?.clientId ?? 'catalog-svc',
      brokers,
      retry: { initialRetryTime: 300, retries: 3 },
    });
    this.consumer = this.kafka.consumer({
      groupId: options?.groupId ?? 'catalog-svc',
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const enabled = this.configService.get<boolean | string>(
      'KAFKA_CONSUMER_ENABLED',
      true,
    );
    if (enabled === false || enabled === 'false') {
      this.logger.warn(
        'KAFKA_CONSUMER_ENABLED=false; stock reservations will not be committed from order.created',
      );
      return;
    }

    // Connect in the background so the API boots while Kafka is unavailable.
    void this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async connectWithRetry(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    try {
      await this.consumer.connect();
      await this.producer.connect();

      for (const topic of CATALOG_CONSUMER_TOPICS) {
        await this.consumer.subscribe({ topic, fromBeginning: false });
      }

      await this.consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          await this.processMessage(topic, partition, message);
        },
      });

      this.isRunning = true;
      this.logger.log(
        `KafkaOrderConsumer subscribed to ${CATALOG_CONSUMER_TOPICS.join(', ')}`,
      );
    } catch (error) {
      this.logger.warn(
        `KafkaOrderConsumer failed to connect: ${describe(error)}. Retrying in 5 seconds...`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.connectRetryTimer) {
      clearTimeout(this.connectRetryTimer);
    }
    this.connectRetryTimer = setTimeout(() => {
      void this.connectWithRetry();
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.connectRetryTimer) {
      clearTimeout(this.connectRetryTimer);
      this.connectRetryTimer = null;
    }

    this.isRunning = false;

    try {
      await this.consumer.disconnect();
    } catch {
      // Ignore disconnect error during shutdown
    }

    try {
      await this.producer.disconnect();
    } catch {
      // Ignore disconnect error during shutdown
    }
  }

  /**
   * Processes a single incoming Kafka message. Public for tests.
   *
   * Every branch commits the offset — a record that can never succeed must not
   * become a head-of-line block for its partition — and the offset is committed
   * only after any DLQ write has succeeded.
   */
  async processMessage(
    topic: string,
    partition: number,
    message: {
      key?: Buffer | string | null;
      value: Buffer | string | null;
      offset: string;
    },
  ): Promise<void> {
    const rawString = message.value?.toString() ?? '';
    const nextOffset = (BigInt(message.offset) + 1n).toString();
    const commit = async (): Promise<void> => {
      await this.consumer.commitOffsets([
        { topic, partition, offset: nextOffset },
      ]);
    };

    let envelope: unknown;
    try {
      envelope = JSON.parse(rawString);
    } catch (error) {
      const reason = describe(error);
      this.logger.warn(
        `Malformed JSON on ${topic} at offset ${message.offset}: ${reason}. Routing to the DLQ`,
      );
      await this.sendToDlq(topic, partition, message, {
        reason: 'invalid-json',
        error: reason,
        rawValue: rawString,
      });
      this.metrics.record('invalid');
      await commit();
      return;
    }

    const route = this.routes[topic];
    if (!route) {
      // Not a topic this consumer routes. Redelivering cannot help, so the
      // record is consumed and counted rather than parked forever.
      this.logger.warn(
        `No route for topic ${topic} at offset ${message.offset}; committing without a side effect`,
      );
      this.metrics.record('ignored');
      await commit();
      return;
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        const outcome = await route(envelope);

        // Side effects first, counters second: a failed DLQ write leaves the
        // record un-counted and the offset uncommitted.
        if (outcome.kind === 'invalid') {
          await this.sendToDlq(topic, partition, message, {
            reason:
              outcome.stage === 'envelope'
                ? 'invalid-envelope'
                : 'invalid-payload',
            error: outcome.error,
            originalPayload: envelope,
          });
        }

        recordOutcome(this.metrics, outcome);
        this.logOutcome(topic, message.offset, outcome);
        await commit();
        return;
      } catch (err) {
        // A closed or mismatched reservation cannot be repaired by consuming
        // the event again: retrying only delays the dead letter.
        const terminal = terminalReason(err);
        if (terminal) {
          this.logger.error(
            `Terminal failure on ${topic} offset ${message.offset} (${terminal}): ${describe(err)}`,
          );
          await this.sendToDlq(topic, partition, message, {
            reason: terminal,
            error: describe(err),
            originalPayload: envelope,
          });
          await commit();
          return;
        }

        if (attempt < this.maxRetries) {
          const delay =
            this.retryDelaysMs[attempt] ??
            this.retryDelaysMs[this.retryDelaysMs.length - 1];
          this.logger.warn(
            `Failed processing ${topic} offset ${message.offset} (attempt ${attempt + 1}/${this.maxRetries}): ${describe(err)}. Retrying in ${delay}ms...`,
          );
          await this.sleep(delay);
          attempt++;
          continue;
        }

        this.logger.error(
          `Exhausted retries on ${topic} offset ${message.offset}. Routing to the DLQ`,
          err instanceof Error ? err.stack : String(err),
        );

        // A missing reservation may just be a hold whose transaction has not
        // committed yet, so it gets its own DLQ reason instead of the generic
        // one: replaying it after the hold lands usually succeeds.
        await this.sendToDlq(topic, partition, message, {
          reason:
            err instanceof NotFoundException
              ? 'reservation-missing'
              : 'transient-exhausted',
          error: describe(err),
          originalPayload: envelope,
        });

        // Offset committed ONLY after a successful DLQ publish.
        await commit();
        return;
      }
    }
  }

  /**
   * A DLQ name comes from the registry when the topic is registered there, so
   * the producer of the twin topic and this consumer cannot disagree.
   */
  private dlqTopicFor(topic: string): string {
    return isEventTopic(topic) ? dlqTopicName(topic) : `${topic}.dlq`;
  }

  private async sendToDlq(
    topic: string,
    partition: number,
    message: { key?: Buffer | string | null; offset: string },
    record: DlqRecord,
  ): Promise<void> {
    await this.producer.send({
      topic: this.dlqTopicFor(topic),
      messages: [
        {
          key: message.key ? message.key.toString() : null,
          value: JSON.stringify({
            source: { topic, partition, offset: message.offset },
            failedAt: new Date().toISOString(),
            ...record,
          }),
        },
      ],
    });

    this.metrics.record('dlq');
  }

  private logOutcome(
    topic: string,
    offset: string,
    outcome: OrderCreatedOutcome,
  ): void {
    switch (outcome.kind) {
      case 'committed':
        if (outcome.outcome === 'already-committed') {
          this.logger.debug(
            `Reservation ${outcome.reservationId} was already committed to order ${outcome.orderId}; event ${outcome.eventId} is a no-op`,
          );
          return;
        }
        this.logger.log(
          `Committed reservation ${outcome.reservationId} for order ${outcome.orderId} (event ${outcome.eventId})`,
        );
        return;
      case 'duplicate':
        this.logger.debug(
          `Event ${outcome.eventId} on ${topic} offset ${offset} was already applied; skipped`,
        );
        return;
      case 'ignored':
        // Warned for a missing reservation (worth seeing), debug otherwise.
        this.logger.debug(
          `Ignored event on ${topic} offset ${offset} (${outcome.reason})`,
        );
        return;
      case 'invalid':
        // Already routed to the DLQ by the caller.
        return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function terminalReason(err: unknown): DlqReason | null {
  if (err instanceof ReservationClosedError) return 'reservation-closed';
  if (err instanceof ReservationMismatchError) return 'reservation-mismatch';
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
