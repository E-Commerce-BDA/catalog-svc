import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { assertFixtureSeedAllowed } from './config/fixture-seed.guard.js';
import { startEventConsumer } from './events/consumer-runtime.js';

async function bootstrap() {
  // Before the app is built: a misconfigured production box must not open a
  // database connection at all.
  assertFixtureSeedAllowed();

  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 4020;
  const config = app.get(ConfigService);

  app.setGlobalPrefix('/api/v1', {
    exclude: ['health', 'health/ready'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.listen(port);

  // Deliberately not awaited. The API answers as soon as it is listening, and a
  // broker that is down only delays the consumer: `startEventConsumer` retries
  // every five seconds and never rejects, so reservations and imports catch up
  // instead of the process refusing to start.
  void startEventConsumer(app, config);
}
await bootstrap();
