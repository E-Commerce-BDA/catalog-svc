import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CommitStockDto } from './dto/commit-stock.dto.js';
import type { ReleaseStockDto } from './dto/release-stock.dto.js';
import type { ReserveStockDto } from './dto/reserve-stock.dto.js';
import { StockReservationsRepository } from './stock-reservations.repository.js';
import type {
  ExpiredReservation,
  StockCommitResult,
  StockReleaseResult,
  StockReservationItem,
  StockReservationResult,
  StockReservationView,
} from './stock.types.js';

const DEFAULT_TTL_SECONDS = 900;

@Injectable()
export class StockReservationsService {
  private readonly logger = new Logger(StockReservationsService.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly reservations: StockReservationsRepository,
    configService: ConfigService,
  ) {
    this.ttlSeconds =
      configService.get<number>('STOCK_RESERVATION_TTL_SECONDS') ??
      DEFAULT_TTL_SECONDS;
  }

  async reserve(dto: ReserveStockDto): Promise<StockReservationResult> {
    const items = this.coalesceItems(dto.items);
    if (items.length === 0) {
      throw new BadRequestException('At least one item must be reserved');
    }

    const { result, replayed } = await this.reservations.reserve(
      dto.reservationId,
      items,
      this.ttlSeconds,
      dto.orderId,
    );

    if (replayed) {
      this.logger.log(
        `Replayed reservation ${dto.reservationId} (${result.status})`,
      );
    }

    return result;
  }

  async release(dto: ReleaseStockDto): Promise<StockReleaseResult> {
    return this.reservations.release(dto.reservationId);
  }

  async commit(dto: CommitStockDto): Promise<StockCommitResult> {
    return this.reservations.commit(dto.reservationId, dto.orderId);
  }

  async getReservation(reservationId: string): Promise<StockReservationView> {
    const reservation = await this.reservations.getById(reservationId);
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    return reservation;
  }

  /** Called by the expiry scheduler and by tests; safe to run concurrently. */
  async sweepExpired(limit = 100): Promise<ExpiredReservation[]> {
    const expired = await this.reservations.expireDue(limit);
    if (expired.length > 0) {
      this.logger.warn(
        `Released ${expired.length} expired stock reservation(s)`,
      );
    }
    return expired;
  }

  /**
   * Sums duplicate product/variant lines. Two lines for the same variant would
   * otherwise lock the same row twice inside one transaction.
   */
  private coalesceItems(items: StockReservationItem[]): StockReservationItem[] {
    const merged = new Map<string, StockReservationItem>();

    for (const item of items) {
      const key = `${item.productId}:${item.variantId ?? ''}`;
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        continue;
      }
      merged.set(key, {
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
      });
    }

    return [...merged.values()];
  }
}
