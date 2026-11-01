import { describe, expect, it } from 'vitest';
import { assertFixtureSeedAllowed } from './fixture-seed.guard.js';

describe('assertFixtureSeedAllowed', () => {
  it('refuses to boot production with the fixture flag on', () => {
    expect(() =>
      assertFixtureSeedAllowed({
        NODE_ENV: 'production',
        CATALOG_ALLOW_FIXTURE_SEED: 'true',
      }),
    ).toThrow(/CATALOG_ALLOW_FIXTURE_SEED=true is refused/);
  });

  it('allows development with the flag on', () => {
    expect(() =>
      assertFixtureSeedAllowed({
        NODE_ENV: 'development',
        CATALOG_ALLOW_FIXTURE_SEED: 'true',
      }),
    ).not.toThrow();
  });

  it('allows production when the flag is absent or false', () => {
    expect(() =>
      assertFixtureSeedAllowed({ NODE_ENV: 'production' }),
    ).not.toThrow();
    expect(() =>
      assertFixtureSeedAllowed({
        NODE_ENV: 'production',
        CATALOG_ALLOW_FIXTURE_SEED: 'false',
      }),
    ).not.toThrow();
  });

  it('only recognises the exact documented value', () => {
    // A near-miss like "TRUE" means nothing seeds at all, which is the safe
    // direction — the guard must not refuse to boot a production box over it.
    expect(() =>
      assertFixtureSeedAllowed({
        NODE_ENV: 'production',
        CATALOG_ALLOW_FIXTURE_SEED: 'TRUE',
      }),
    ).not.toThrow();
  });
});
