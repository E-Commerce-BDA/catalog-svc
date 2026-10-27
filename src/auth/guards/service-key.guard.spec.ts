import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERNAL_SERVICE_KEY,
  ServiceKeyGuard,
} from './service-key.guard.js';

describe('ServiceKeyGuard', () => {
  let guard: ServiceKeyGuard;

  beforeEach(() => {
    guard = new ServiceKeyGuard();
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  const createMockContext = (headers: Record<string, string | undefined>): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should throw UnauthorizedException when x-service-key header is missing', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Missing x-service-key header'),
    );
  });

  it('should throw UnauthorizedException when x-service-key does not match default key', () => {
    const context = createMockContext({ 'x-service-key': 'wrong-key' });
    expect(() => guard.canActivate(context)).toThrow(
      new UnauthorizedException('Invalid service key'),
    );
  });

  it('should allow access when x-service-key matches default key', () => {
    const context = createMockContext({
      'x-service-key': DEFAULT_INTERNAL_SERVICE_KEY,
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access when x-service-key matches environment configured key', () => {
    process.env.INTERNAL_SERVICE_KEY = 'custom-prod-key-xyz';
    const context = createMockContext({
      'x-service-key': 'custom-prod-key-xyz',
    });
    expect(guard.canActivate(context)).toBe(true);
  });
});
