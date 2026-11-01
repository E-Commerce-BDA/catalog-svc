/**
 * Refuses to boot a production catalog-svc with the fixture flag on.
 *
 * `db/seed.mjs` already refuses on its own, but a script runs with whatever
 * environment the operator happens to have; a *deployed* process is what serves
 * customers. A box that is configured this way is misconfigured, and finding out
 * at boot is much cheaper than discovering demo products in a live catalogue.
 *
 * Development is allowed because that is the only place fixtures belong, and a
 * production box that never sets the flag is untouched.
 */
export function assertFixtureSeedAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.CATALOG_ALLOW_FIXTURE_SEED !== 'true') return;

  throw new Error(
    'CATALOG_ALLOW_FIXTURE_SEED=true is refused with NODE_ENV=production: ' +
      'the fixture seed writes demo products. Production data arrives through ' +
      'admin CRUD and product.imported; remove the flag to boot.',
  );
}
