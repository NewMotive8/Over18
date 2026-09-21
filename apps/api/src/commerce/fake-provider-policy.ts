/**
 * WHEN A FAKE COMMERCE PROVIDER MAY EXIST AT ALL. FAIL CLOSED.
 *
 * The original rule was "fake unless NODE_ENV === 'production'". That fails
 * OPEN: an unset, misspelled or differently-cased NODE_ENV on a real server
 * counted as "not production" and let a fake payment provider grant Credits for
 * nothing. Production's NODE_ENV comes from the Railpack image, not from a
 * Railway variable, so nothing in this repository guaranteed it.
 *
 * The rule is therefore inverted: nothing is allowed unless it names itself.
 * There are exactly TWO doors, and a process must walk fully through one.
 *
 *   1. A DEVELOPER'S OWN MACHINE -- NODE_ENV is explicitly `development` or
 *      `test` (exact, after trimming) AND no RAILWAY_* identity variable is
 *      present, which Railway injects into every deployment of every
 *      environment.
 *
 *   2. THE STAGING DEPLOYMENT -- RAILWAY_ENVIRONMENT_NAME is exactly `staging`
 *      AND `ALLOW_SIMULATED_PAYMENTS` is exactly `true`. Both, deliberately
 *      set, on that one environment.
 *
 * Anything else -- unset, `production`, `Development`, a Railway process that
 * is not staging, or staging without the opt-in -- is treated as production.
 *
 * -- WHY DOOR 2 CANNOT OPEN IN PRODUCTION -------------------------------------
 *
 * Door 2 exists so the simulated purchase flow can be reviewed on a deployed
 * URL. It cannot test NODE_ENV the way door 1 does, because staging is built
 * from the same Railpack image as production and therefore reports `production`
 * as well; requiring otherwise would make the door permanently shut.
 *
 * What keeps it shut in production is that BOTH of its conditions are false
 * there, independently of each other:
 *   - Railway sets RAILWAY_ENVIRONMENT_NAME from the environment's own name.
 *     The production environment is named `production`. A deployment cannot
 *     choose or forge this value.
 *   - ALLOW_SIMULATED_PAYMENTS is set on staging only, and is not a shared
 *     variable, so it does not exist on any production service.
 * Opening this door in production would require renaming the production
 * environment to `staging` AND adding the opt-in variable to it. Neither
 * happens by accident, and the tests pin both halves separately.
 *
 * -- SCOPE --------------------------------------------------------------------
 *
 * The flag is named for payments, because that is what it is for, but this
 * function gates EVERY fake commerce provider, age verification included. A
 * fake is still only built for a provider the environment separately asks for
 * (`PAYMENT_PROVIDER`, `AGE_VERIFICATION_PROVIDER`), and staging asks for a
 * fake payment provider and nothing else. Anyone widening that should read this.
 *
 * Deliberately a pure function of the environment it is given, so all three
 * locks (`loadEnv`, the provider selectors, and the simulation service)
 * evaluate it themselves instead of trusting a boolean some caller computed.
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

/** The one deployed environment allowed to simulate, spelled exactly. */
const STAGING_ENVIRONMENT_NAME = 'staging';

/** The deliberate opt-in that door 2 also requires. */
const SIMULATION_OPT_IN = 'ALLOW_SIMULATED_PAYMENTS';

const read = (environ: NodeJS.ProcessEnv, name: string): string => (environ[name] ?? '').trim();

function onRailway(environ: NodeJS.ProcessEnv): boolean {
  return RAILWAY_IDENTITY_VARIABLES.some((name) => read(environ, name) !== '');
}

/** Door 1: an explicit development or test process on somebody's own machine. */
function localDevelopmentOrTest(environ: NodeJS.ProcessEnv): boolean {
  return EXPLICIT_NON_PRODUCTION.has(read(environ, 'NODE_ENV')) && !onRailway(environ);
}

/** Door 2: the staging environment, and only with the opt-in also set. */
function optedInStaging(environ: NodeJS.ProcessEnv): boolean {
  return (
    read(environ, 'RAILWAY_ENVIRONMENT_NAME').toLowerCase() === STAGING_ENVIRONMENT_NAME &&
    read(environ, SIMULATION_OPT_IN).toLowerCase() === 'true'
  );
}

export function fakeProvidersAllowed(environ: NodeJS.ProcessEnv = process.env): boolean {
  return localDevelopmentOrTest(environ) || optedInStaging(environ);
}
