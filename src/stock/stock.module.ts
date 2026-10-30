import { Module } from '@nestjs/common';
import { StockReservationsRepository } from './stock-reservations.repository.js';
import { StockReservationsService } from './stock-reservations.service.js';
import { StockReservationScheduler } from './stock-reservations.scheduler.js';

@Module({
  providers: [
    StockReservationsRepository,
    StockReservationsService,
    StockReservationScheduler,
  ],
  // The repository is exported for the `order.created` handler, which owns the
  // transaction that spans the claim and the commit.
  exports: [StockReservationsService, StockReservationsRepository],
})
export class StockModule {}
