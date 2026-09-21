import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import CharacterEligibilityPanel from './CharacterEligibilityPanel';
import type { CharacterReadiness } from '../lib/api';

/**
 * P0.1 -- the Character Detail panel renders the SERVER's verdict. These pin
 * that it shows it faithfully and that it holds no rule of its own.
 *
 * The Publishability card was removed from this panel. The verdict itself is
 * untouched: the API still computes it and still returns it on the character
 * detail, and the last test here holds the line that it is no longer drawn.
 */

const requirements = { required: 2, approved: 2, pending: 0, missing: 0, complete: true };
const ready: CharacterReadiness = { ready: true, blockers: [], requirements };

describe('the Readiness panel', () => {
  it('shows Ready and no reasons when nothing blocks', () => {
    const html = renderToStaticMarkup(<CharacterEligibilityPanel readiness={ready} />);
    expect(html).toContain('>Ready<');
    expect(html).not.toContain('<li');
  });

  it('shows Not ready with the server’s reasons, verbatim', () => {
    const html = renderToStaticMarkup(
      <CharacterEligibilityPanel
        readiness={{
          ready: false,
          requirements,
          blockers: [
            { code: 'requirement_unmet', message: 'Selfies: 1 of 2 approved; 1 item awaiting review.' },
            { code: 'no_active_visual_identity', message: 'She has no active visual identity. Create or activate one.' },
          ],
        }}
      />,
    );
    expect(html).toContain('>Not ready<');
    expect(html).toContain('Selfies: 1 of 2 approved; 1 item awaiting review.');
    expect(html).toContain('She has no active visual identity. Create or activate one.');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it('says what readiness is about', () => {
    expect(renderToStaticMarkup(<CharacterEligibilityPanel readiness={ready} />)).toContain(
      'Production work: required content and an active identity.',
    );
  });

  /**
   * THE CARD IS GONE, not hidden behind a falsy verdict: neither a publishable
   * nor an unpublishable character draws one, because the panel no longer
   * receives the verdict at all.
   */
  it('renders no Publishability card', () => {
    const html = renderToStaticMarkup(<CharacterEligibilityPanel readiness={ready} />);
    for (const gone of ['Publishability', 'Publishable', 'Not publishable', 'eligibility-publishability']) {
      expect({ gone, found: html.includes(gone) }).toEqual({ gone, found: false });
    }
    expect(html.match(/data-testid="eligibility-/g)).toHaveLength(1);
  });

  /**
   * NO RULES IN THE BROWSER. The component may only read the verdict boolean
   * and each blocker's message -- never a status, a count or a blocker code to
   * decide something. Comments are stripped so the prose explaining this does
   * not trip the check.
   */
  it('reads only the verdict and messages, never the facts behind them', () => {
    const code = readFileSync(fileURLToPath(new URL('./CharacterEligibilityPanel.tsx', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Property reads and comparisons, not words: the panel's own copy may say
    // "required content" without deciding anything with it.
    for (const forbidden of ['.status', '.approved', '.pending', '.required', '.remaining', '.requirements', '.fields', 'profileComplete', 'code ===', 'code !==']) {
      expect({ forbidden, found: code.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
  });
});
