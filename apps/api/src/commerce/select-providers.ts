import type { CommerceProviderName } from '../env.js';
import type { AgeVerificationProvider } from './age-verification-provider.js';
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
 */

export class FakeProviderInProductionError extends Error {
  constructor(kind: string) {
    super(`Refusing to use the fake ${kind} provider in production.`);
    this.name = 'FakeProviderInProductionError';
  }
}

interface FakeOptions {
  isProduction: boolean;
  secret: string;
  baseUrl: string;
}

export function selectPaymentProvider(
  name: CommerceProviderName,
  options: FakeOptions,
): PaymentProvider | null {
  if (name === 'none') return null;
  if (options.isProduction) throw new FakeProviderInProductionError('payment');
  return createFakePaymentProvider({ secret: options.secret, checkoutBaseUrl: options.baseUrl });
}

export function selectAgeVerificationProvider(
  name: CommerceProviderName,
  options: FakeOptions,
): AgeVerificationProvider | null {
  if (name === 'none') return null;
  if (options.isProduction) throw new FakeProviderInProductionError('age-verification');
  return createFakeAgeVerificationProvider({
    secret: options.secret,
    verifyBaseUrl: options.baseUrl,
  });
}
