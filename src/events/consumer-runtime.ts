import {
  Injectable,
  Logger,
  type INestApplication,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaDlqPublisher, KafkaLagSampler, type RelayLogger } from '@ecom/messaging';
import { createKafkaConsumerStrategy } from '@ecom/messaging/nest';
import { CATALOG_CONSUMER_TOPICS } from './catalog-topics.js';

/**
 * The consumer group, which is exactly the service name.
 *
 * The Nest strategy appends `-server` unless told otherwise, and that would be
 * a second group with its own offsets from the hand-written kafkajs consumer
 * this replaces (`cat-007`'s `KafkaOrderConsumer`) — so `postfixId: ""` in the
 * strategy and this constant have to agree.
 */
export const CONSUMER_GROUP_ID = 'catalog-svc';

/** `KAFKA_BROKERS`, split the way every other consumer in the platform does. */
export function kafkaBrokers(config: ConfigService): string[] {
  return config
    .get<string>('KAFKA_BROKERS', 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
}

/**
 * Adapts the shared protocol's three-method logger onto Nest's, so consumer
 * warnings land in the same stream as the rest of the service's logs.
 */
export class NestRelayLogger implements RelayLogger {
  constructor(private readonly logger: Logger) {}

  debug(message: string): void {
    this.logger.debug(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string, error?: unknown): void {
    this.logger.error(message, formatError(error));
  }
}

/** Flattens a thrown value into something Nest prints readably. */
function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return `${error}`;
  }
  if (error === undefined || error === null) {
    return undefined;
  }

  return JSON.stringify(error);
}

const consumerLogger = new Logger('EventConsumer');

/** How long to wait before re-attempting a consumer start. */
const RECONNECT_DELAY_MS = 5000;

/**
 * Starts the catalog consumer on the Nest Kafka transport.
 *
 * Deliberately separate from the HTTP bootstrap: every e2e suite builds the
 * module and calls `app.init()`, and an HTTP test must never join a consumer
 * group — so the switch is `KAFKA_CONSUMER_ENABLED` (default on) rather than
 * "does the module happen to be imported".
 *
 * `connectMicroservice` registers the strategy and `startAllMicroservices` is
 * what subscribes and starts the run loop; `app.listen()` does neither on its
 * own in this Nest version.
 *
 * A broker that is down does **not** stop the service. Catalog can still answer
 * reads from PostgreSQL, and refusing to serve the catalog because Kafka is
 * restarting is a worse outcome than reservations that commit a minute late. So
 * a failed start is retried every five seconds and `main.ts` does not await it.
 *
 * Resolves `true` once the consumer is running, `false` when it is switched off.
 * The live e2e spec awaits this to prove the group joined.
 */
export async function startEventConsumer(
  app: INestApplication,
  config: ConfigService,
): Promise<boolean> {
  const enabled = config.get<string | boolean>('KAFKA_CONSUMER_ENABLED', true);

  if (enabled === false || enabled === 'false') {
    consumerLogger.warn(
      'KAFKA_CONSUMER_ENABLED=false; the event consumer is not started, so stock reservations stay held and product imports are not applied',
    );
    return false;
  }

  app.connectMicroservice({
    strategy: createKafkaConsumerStrategy({
      brokers: kafkaBrokers(config),
      clientId: CONSUMER_GROUP_ID,
      groupId: CONSUMER_GROUP_ID,
    }),
  });

  const started = await startWithRetry(app);

  if (started) {
    // Sampled only once there is a consumer: a gauge over a group that has not
    // joined would report the whole topic as lag.
    app.get(ConsumerRuntime).startLagSampler();
    consumerLogger.log(
      `Event consumer started: group ${CONSUMER_GROUP_ID} on the Nest Kafka transport, topics ${CATALOG_CONSUMER_TOPICS.join(', ')}`,
    );
  }

  return started;
}

/**
 * Retries until the consumer is up. The wait is unref'd, so a process whose
 * consumer never connects can still exit on its own.
 */
async function startWithRetry(app: INestApplication): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await app.startAllMicroservices();
      return true;
    } catch (error) {
      consumerLogger.error(
        `Event consumer failed to start (attempt ${attempt}): ${describe(error)}. Retrying in ${RECONNECT_DELAY_MS / 1000}s`,
      );
      await pause(RECONNECT_DELAY_MS);
    }
  }
}

/**
 * Owns the two connections that are not the consumer itself: the dead-letter
 * producer and the lag gauge.
 *
 * The gauge is started explicitly, after the consumer is up, rather than from
 * `onModuleInit` — a test that builds this module must not open an admin
 * connection to a broker it never asked for.
 */
@Injectable()
export class ConsumerRuntime implements OnModuleDestroy {
  private readonly logger = new Logger(ConsumerRuntime.name);
  private sampling = false;

  constructor(
    private readonly lag: KafkaLagSampler,
    private readonly dlq: KafkaDlqPublisher,
  ) {}

  startLagSampler(): void {
    if (this.sampling) {
      return;
    }
    this.sampling = true;
    this.lag.start();
    this.logger.log('Consumer lag sampling started (every 15s)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.lag.stop();
    await this.dlq.close();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
