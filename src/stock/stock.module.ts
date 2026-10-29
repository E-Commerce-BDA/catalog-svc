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
  exports: [StockReservationsService],
})
export class StockModule {}
