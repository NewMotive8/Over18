import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import CharacterEligibilityPanel from './CharacterEligibilityPanel';
import type { CharacterPublishability, CharacterReadiness } from '../lib/api';

/**
 * P0.1 -- the Character Detail panel renders the SERVER's verdicts. These pin
 * that it shows them faithfully and that it holds no rule of its own.
 */

const requirements = { required: 2, approved: 2, pending: 0, missing: 0, complete: true };
const ready: CharacterReadiness = { ready: true, blockers: [], requirements };
const publishable: CharacterPublishability = { publishable: true, blockers: [] };

describe('Readiness and Publishability panel', () => {
  it('shows Ready / Publishable and no reasons when nothing blocks', () => {
    const html = renderToStaticMarkup(<CharacterEligibilityPanel readiness={ready} publishability={publishable} />);
    expect(html).toContain('>Ready<');
    expect(html).toContain('>Publishable<');
    expect(html).not.toContain('<li');
  });

  it('shows Not ready / Not publishable with the server’s reasons, verbatim', () => {
    const html = renderToStaticMarkup(
      <CharacterEligibilityPanel
        readiness={{
          ready: false,
          requirements,
          blockers: [{ code: 'requirement_unmet', message: 'Selfies: 1 of 2 approved; 1 item awaiting review.' }],
        }}
        publishability={{
          publishable: false,
          blockers: [
            { code: 'character_inactive', message: 'She is not live. Publish her to make her visible.' },
            { code: 'no_active_visual_identity', message: 'She has no active visual identity. Create or activate one.' },
          ],
        }}
      />,
    );
    expect(html).toContain('>Not ready<');
    expect(html).toContain('>Not publishable<');
    expect(html).toContain('Selfies: 1 of 2 approved; 1 item awaiting review.');
    expect(html).toContain('She is not live. Publish her to make her visible.');
    expect(html).toContain('She has no active visual identity. Create or activate one.');
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it('keeps the two verdicts independent -- ready but not publishable renders exactly that', () => {
    const html = renderToStaticMarkup(
      <CharacterEligibilityPanel
        readiness={ready}
        publishability={{ publishable: false, blockers: [{ code: 'character_inactive', message: 'Offline.' }] }}
      />,
    );
    expect(html).toContain('>Ready<');
    expect(html).toContain('>Not publishable<');
  });

  it('says that publishable is not distribution', () => {
    const html = renderToStaticMarkup(<CharacterEligibilityPanel readiness={ready} publishability={publishable} />);
    expect(html).toContain('Placement on Posts, Home, categories or Discovery is separate.');
  });

  /**
   * NO RULES IN THE BROWSER. The component may only read the verdict booleans
   * and each blocker's message -- never a status, a count or a blocker code to
   * decide something. Comments are stripped so the prose explaining this does
   * not trip the check.
   */
  it('reads only the verdicts and messages, never the facts behind them', () => {
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
