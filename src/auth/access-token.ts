import { JwtService } from '@nestjs/jwt';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_CLOCK_TOLERANCE_SECONDS,
  JWT_ISSUER,
} from './auth.constants.js';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  roles: string[];
}

/**
 * Single verification path for every catalog-svc guard.
 *
 * Admin catalog routes must agree on issuer, audience, algorithm,
 * and clock tolerance with auth-svc.
 */
export async function verifyAccessToken(
  jwtService: JwtService,
  token: string,
): Promise<AuthenticatedUser> {
  return jwtService.verifyAsync<AuthenticatedUser>(token, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [JWT_ALGORITHM],
    clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
  });
}
