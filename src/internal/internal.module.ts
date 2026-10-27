import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller.js';
import { InternalService } from './internal.service.js';

@Module({
  controllers: [InternalController],
  providers: [InternalService]
})
export class InternalModule {}
