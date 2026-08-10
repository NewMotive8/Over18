import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('renders the title, description, badge and action', () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No steady connections yet"
        description="They'll show up here."
        badge="Coming soon"
        action={<a href="/characters">Discover</a>}
      />,
    );
    expect(html).toContain('No steady connections yet');
    expect(html).toContain('show up here.'); // apostrophe is HTML-escaped in static markup
    expect(html).toContain('Coming soon');
    expect(html).toContain('href="/characters"');
  });
});
