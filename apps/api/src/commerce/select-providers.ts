import type { CommerceProviderName } from '../env.js';
import type { AgeVerificationProvider } from './age-verification-provider.js';
import { fakeProvidersAllowed } from './fake-provider-policy.js';
import {
  createFakeAgeVerificationProvider,
  createFakePaymentProvider,
} from './fake-providers.js';
import type { PaymentProvider } from './payment-provider.js';

/**
 * Chooses the configured providers. `none` is null: a feature that needs a
 * provider must treat its absence as "switched off", not as an error.
 *
 * A FAKE IS REFUSED IN PRODUCTION HERE TOO, independently of `loadEnv`. Two
 * locks, because the failure they prevent -- Credits granted for a payment that
 * never happened -- is a direct financial loss.
 *
 * This lock reads the environment itself (see fake-provider-policy.ts) rather
 * than taking an `isProduction` flag from the caller, and it fails closed: a
 * fake is built only in an explicit development/test process off Railway, or on
 * the staging environment with its opt-in variable deliberately set.
 */

export class FakeProviderInProductionError extends Error {
  constructor(kind: string) {
    super(
      `Refusing to use the fake ${kind} provider: fakes are allowed only when NODE_ENV is ` +
        'development or test and the process is not running on Railway, or when ' +
        'RAILWAY_ENVIRONMENT_NAME is staging and ALLOW_SIMULATED_PAYMENTS is true.',
    );
    this.name = 'FakeProviderInProductionError';
  }
}

interface FakeOptions {
  secret: string;
  baseUrl: string;
  /** The environment to judge. Defaults to `process.env`; tests pass their own. */
  environ?: NodeJS.ProcessEnv;
}

export function selectPaymentProvider(
  name: CommerceProviderName,
  options: FakeOptions,
): PaymentProvider | null {
  if (name === 'none') return null;
  if (!fakeProvidersAllowed(options.environ)) throw new FakeProviderInProductionError('payment');
  return createFakePaymentProvider({ secret: options.secret, checkoutBaseUrl: options.baseUrl });
}

export function selectAgeVerificationProvider(
  name: CommerceProviderName,
  options: FakeOptions,
): AgeVerificationProvider | null {
  if (name === 'none') return null;
  if (!fakeProvidersAllowed(options.environ)) {
    throw new FakeProviderInProductionError('age-verification');
  }
  return createFakeAgeVerificationProvider({
    secret: options.secret,
    verifyBaseUrl: options.baseUrl,
  });
}
