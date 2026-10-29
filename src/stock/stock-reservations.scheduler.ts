import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StockReservationsService } from './stock-reservations.service.js';

const SWEEP_BATCH_SIZE = 100;

/**
 * Reclaims stock from holds that were never committed — the checkout crashed,
 * the payment failed, or the order was abandoned. Without this, a hold taken
 * for a product that is never ordered again would be lost permanently.
 */
@Injectable()
export class StockReservationScheduler {
  private readonly logger = new Logger(StockReservationScheduler.name);

  constructor(private readonly stockReservations: StockReservationsService) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async handleExpirySweep(): Promise<void> {
    // e2e suites drive sweepExpired() explicitly; a background timer would make
    // their assertions racy.
    if (process.env.NODE_ENV === 'test') return;

    try {
      await this.stockReservations.sweepExpired(SWEEP_BATCH_SIZE);
    } catch (err) {
      this.logger.error(
        'Stock reservation expiry sweep failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
