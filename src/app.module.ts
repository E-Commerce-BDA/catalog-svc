import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { BrandsModule } from './brands/brands.module.js';
import { ProductsModule } from './products/products.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { InternalModule } from './internal/internal.module.js';
import { EventsModule } from './events/events.module.js';
import { StockModule } from './stock/stock.module.js';
import Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(4020),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        KAFKA_BROKERS: Joi.string().default('localhost:9092'),
        STOCK_RESERVATION_TTL_SECONDS: Joi.number()
          .integer()
          .min(60)
          .default(900),
      }),
    }),
    ScheduleModule.forRoot(),
    EventsModule,
    HealthModule,
    DbModule,
    AuthModule,
    CommonModule,
    CategoriesModule,
    BrandsModule,
    ProductsModule,
    InventoryModule,
    InternalModule,
    StockModule,
  ],
})
export class AppModule {}
