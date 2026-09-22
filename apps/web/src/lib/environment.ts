/**
 * WHICH DEPLOYMENT THIS BUNDLE IS.
 *
 * Read from `VITE_ENVIRONMENT`, which Vite bakes in at BUILD time. That is the
 * point: a production build physically cannot contain a staging marker, because
 * the value was fixed when the bundle was compiled and there is no runtime
 * switch to flip.
 *
 * FAIL CLOSED, like every other flag in this codebase. Staging is recognised
 * only for the exact string `staging`, after trimming and lower-casing. Unset,
 * misspelled, `Staging `, `production`, anything else at all -- none of them is
 * staging. The failure this protects against is a production deployment wearing
 * a "THIS IS STAGING" banner, which would teach customers to ignore it.
 */

const STAGING = 'staging';

/** The declared environment name, normalised. Empty when nothing declared it. */
export function environmentName(env: ImportMetaEnv = import.meta.env): string {
  const value: unknown = (env as Record<string, unknown>).VITE_ENVIRONMENT;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** True ONLY for an explicit staging build. */
export function isStaging(env: ImportMetaEnv = import.meta.env): boolean {
  return environmentName(env) === STAGING;
}
