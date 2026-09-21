import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StagingBanner from './StagingBanner';
import { environmentName, isStaging } from '../lib/environment';

/**
 * The staging warning, and the rule that keeps it out of production.
 *
 * The failure worth guarding is not "the banner is missing on staging" -- that
 * is obvious the moment anyone looks. It is "the banner appears in production",
 * which would teach customers to ignore it.
 */

const env = (value?: unknown) => ({ VITE_ENVIRONMENT: value }) as unknown as ImportMetaEnv;

describe('which builds are staging', () => {
  it('recognises an explicit staging build, however it was cased or padded', () => {
    for (const value of ['staging', 'STAGING', ' Staging ', 'sTaGiNg']) {
      expect(isStaging(env(value)), String(value)).toBe(true);
    }
  });

  it('recognises nothing else at all -- it fails closed', () => {
    for (const value of [undefined, null, '', 'production', 'prod', 'stage', 'staging-2', 'development', 'test', 42, true, {}]) {
      expect(isStaging(env(value)), JSON.stringify(value)).toBe(false);
    }
  });

  it('reports the declared name, normalised, and empty when nothing declared one', () => {
    expect(environmentName(env(' Production '))).toBe('production');
    expect(environmentName(env(undefined))).toBe('');
  });
});

describe('the banner', () => {
  it('renders nothing whatsoever outside a staging build', () => {
    // The component reads the real build's env, which is not staging in tests.
    expect(renderToStaticMarkup(<StagingBanner />)).toBe('');
    expect(isStaging()).toBe(false);
  });
});
