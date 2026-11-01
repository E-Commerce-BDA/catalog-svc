import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    // The e2e config does not load .env, so NODE_ENV is not a reliable guard.
    // Without this every e2e run would boot a real relay against the broker.
    // `KAFKA_CONSUMER_ENABLED` is off for the same reason: no suite may join the
    // `catalog-svc` group, and the consumer specs drive the controller by hand
    // instead.
    env: { DISABLE_OUTBOX_RELAY: 'true', KAFKA_CONSUMER_ENABLED: 'false' },
  },
});
