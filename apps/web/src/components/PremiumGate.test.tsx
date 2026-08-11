import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import PremiumGate from './PremiumGate';

describe('PremiumGate', () => {
  it('is a dialog offering Premium with no real payment surface', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PremiumGate name="Ember" onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Go Premium');
    expect(html).toContain('Ember'); // gate is contextual to the character
    expect(html).toContain('Payments are not enabled');
  });
});
