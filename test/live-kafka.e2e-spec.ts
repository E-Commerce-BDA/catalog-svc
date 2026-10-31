import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';
import type { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { KafkaEventPublisher, OutboxRelay } from '@ecom/messaging';
import { OUTBOX_PUBLISHER, OUTBOX_RELAY } from '@ecom/messaging/nest';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import { catalogOutboxRows, deleteCatalogOutbox } from './outbox.helpers.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}

const RUN_ID = randomUUID().slice(0, 8);
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

/**
 * The one gate that needs a broker. Off by default (and skipped by
 * `vitest run`), because every other suite drives `drainOnce()` against a
 * recording publisher.
 *
 * `RUN_KAFKA_E2E=1 pnpm test:e2e -- test/live-kafka.e2e-spec.ts`
 */
const describeLive = process.env.RUN_KAFKA_E2E === '1' ? describe : describe.skip;

describeLive('Live Kafka delivery (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let moduleRelay: OutboxRelay;
  let publisher: KafkaEventPublisher;
  let kafka: Kafka;
  let adminToken: string;

  const productIds: string[] = [];
  const categoryIds: string[] = [];
  const aggregateIds: string[] = [];

  function trackProduct(id: string): string {
    productIds.push(id);
    aggregateIds.push(id);
    return id;
  }

  function trackCategory(id: string): string {
    categoryIds.push(id);
    aggregateIds.push(id);
    return id;
  }

  function adminPost(path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  }

  /** Drains until this aggregate's row is published, then returns its event id. */
  async function drainAndReadEventId(aggregateId: string): Promise<string> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const rows = await catalogOutboxRows(pool, [aggregateId]);
      const published = rows.find((row) => row.status === 'published');
      if (published) {
        return published.event_id;
      }

      await moduleRelay.drainOnce();
    }

    throw new Error(`no published outbox row for ${aggregateId}`);
  }

  /**
   * Reads the topic from the beginning and resolves when the message carrying
   * this event id arrives. A fresh consumer group per run, so `fromBeginning`
   * replays the topic instead of skipping to the current offset.
   */
  async function expectOnTopic(topic: string, eventId: string): Promise<void> {
    const consumer = kafka.consumer({ groupId: `catalog-live-${RUN_ID}-${topic}` });
    let timer: NodeJS.Timeout | undefined;

    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: true });

    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no ${topic} message for event ${eventId}`)),
        20000,
      );

      void consumer.run({
        eachMessage: async ({ message }) => {
          if (message.headers?.['x-event-id']?.toString() === eventId) {
            resolve();
          }
        },
      });
    });

    try {
      await delivered;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      await consumer.disconnect();
    }
  }

  beforeAll(async () => {
    publisher = new KafkaEventPublisher({
      brokers: () => BROKERS,
      clientId: 'catalog-live-e2e',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The relay's `enabled` flag is read while the module is declared, so an
      // env flip inside this file would be too late; override the publisher.
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const configService = app.get(ConfigService);
    adminToken = await app.get(JwtService).signAsync(
      {
        sub: '0190a8b0-0000-7000-8000-000000000001',
        email: 'admin@example.com',
        roles: ['admin'],
      },
      {
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    pool = getPool();
    moduleRelay = app.get<OutboxRelay>(OUTBOX_RELAY);
    kafka = new Kafka({ clientId: `catalog-live-${RUN_ID}`, brokers: BROKERS });
  });

  afterAll(async () => {
    if (pool) {
      await deleteCatalogOutbox(pool, aggregateIds);

      if (productIds.length > 0) {
        await pool.query(`DELETE FROM catalog.products WHERE id = ANY($1::uuid[])`, [
          productIds,
        ]);
      }
      if (categoryIds.length > 0) {
        await pool.query(
          `DELETE FROM catalog.categories WHERE id = ANY($1::uuid[])`,
          [categoryIds],
        );
      }
    }

    await publisher?.close();

    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('delivers product.updated to its topic', async () => {
    const created = await adminPost('/catalog/products', {
      sku: `live-${RUN_ID}`,
      name: 'Live Kafka Product',
      slug: `live-kafka-${RUN_ID}`,
      price: 42.5,
      stock: 3,
      status: 'active',
    }).expect(201);

    const product = created.body.product as { id: string };
    trackProduct(product.id);

    const eventId = await drainAndReadEventId(product.id);
    await expectOnTopic('product.updated', eventId);
  }, 60000);

  it('delivers category.updated to its topic', async () => {
    const created = await adminPost('/catalog/categories', {
      name: `Live Category ${RUN_ID}`,
      slug: `live-category-${RUN_ID}`,
    }).expect(201);

    const category = created.body.category as { id: string };
    trackCategory(category.id);

    const eventId = await drainAndReadEventId(category.id);
    await expectOnTopic('category.updated', eventId);
  }, 60000);
});
