/**
 * WHEN A FAKE COMMERCE PROVIDER MAY EXIST AT ALL. FAIL CLOSED.
 *
 * The earlier rule was "fake unless NODE_ENV === 'production'". That fails
 * OPEN: an unset, misspelled or differently-cased NODE_ENV on a real server
 * counted as "not production" and let a fake payment provider grant Credits for
 * nothing. Production's NODE_ENV comes from the Railpack image, not from a
 * Railway variable, so nothing in this repository guaranteed it.
 *
 * The rule is now inverted: a fake is allowed ONLY when BOTH hold --
 *   1. NODE_ENV is explicitly `development` or `test` (exact, after trimming);
 *   2. the process is not running on Railway (no RAILWAY_* identity variable,
 *      which Railway injects into every deployment of every environment).
 * Anything else -- unset, `production`, `staging`, `Development`, or any
 * process on Railway -- is treated as production.
 *
 * Deliberately a pure function of the environment it is given, so both locks
 * (`loadEnv` and the provider selectors) evaluate it themselves instead of
 * trusting a boolean some caller computed.
 */

const EXPLICIT_NON_PRODUCTION = new Set(['development', 'test']);

/** Railway injects these into every deployment; any one present means Railway. */
const RAILWAY_IDENTITY_VARIABLES = [
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_SERVICE_ID',
] as const;

export function fakeProvidersAllowed(environ: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (environ.NODE_ENV ?? '').trim();
  if (!EXPLICIT_NON_PRODUCTION.has(nodeEnv)) return false;
  return RAILWAY_IDENTITY_VARIABLES.every((name) => (environ[name] ?? '').trim() === '');
}
