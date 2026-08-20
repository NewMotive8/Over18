import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ContentReviewPage from './ContentReviewPage';
import ContentSettingsPage from './ContentSettingsPage';

/**
 * The two new admin screens, rendered in the repo's node static-rendering
 * setup — no DOM, no jsdom, no testing-library. Effects never run here, so
 * these cover the INITIAL state plus the guarantees that hold at every state:
 * that neither screen ships a category name or a quantity of its own, and that
 * both explain themselves before any data arrives.
 *
 * The loaded board itself is covered where the rules actually live
 * (admin/requirementBoard.test.ts) and end to end by the API suite.
 */

const review = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ContentReviewPage />
    </MemoryRouter>,
  );

const settings = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ContentSettingsPage />
    </MemoryRouter>,
  );

/**
 * The categories and quantities the product currently uses. If any of these
 * ever appears in the rendered output of a screen that has loaded NO data, it
 * has been hard-coded somewhere it must not be.
 */
const CONFIGURED_ELSEWHERE = [
  'Primary — regular / natural',
  'Primary — fully nude',
  'Selfies',
  'Non-explicit / sexy clips',
  'Explicit clips',
  'primary_natural',
  'primary_nude',
  'selfie',
  'explicit',
];

describe('Review is a production workspace, not a queue', () => {
  it('offers upload without asking for a character first', () => {
    const html = review();
    expect(html).toContain('Upload');
    expect(html).toContain('No character needed');
    expect(html).toContain('Inbox');
  });

  it('says what the screen is for before any data arrives', () => {
    const html = review();
    expect(html).toContain('Choose a character');
    expect(html).toContain('Required content');
  });

  it('hard-codes no category and no quantity', () => {
    const html = review();
    for (const term of CONFIGURED_ELSEWHERE) {
      expect(html, `"${term}" must come from configuration`).not.toContain(term);
    }
  });
});

describe('Settings explains consequences, not just fields', () => {
  it('frames the configuration as the single source of truth', () => {
    const html = settings();
    expect(html).toContain('Content requirements');
    expect(html).toContain('single source of truth');
    expect(html).toContain('Review board');
  });

  it('hard-codes no category and no quantity', () => {
    const html = settings();
    for (const term of CONFIGURED_ELSEWHERE) {
      expect(html, `"${term}" must come from configuration`).not.toContain(term);
    }
  });

  it('shows a loading state rather than an empty table', () => {
    expect(settings()).toContain('Loading');
  });
});
