import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicCharacter } from '@over18/shared';
import DiscoverCard from './DiscoverCard';

/**
 * Static render (effects don't run) — the card must paint from the character
 * alone, falling back to profileImage with no visual-identity fetch, and must
 * never crash. Media-first hierarchy: name + tagline over the image.
 */
const nova: PublicCharacter = {
  id: 'c1',
  name: 'nova',
  displayName: 'Nova',
  profileImage: 'https://img.example/nova.png',
  shortBio: 'Night-owl astronomy grad student.',
  personality: 'p',
  interests: [],
  conversationStyle: 's',
};

describe('DiscoverCard', () => {
  it('renders the character identity over the hero media', () => {
    const html = renderToStaticMarkup(<DiscoverCard character={nova} />);
    expect(html).toContain('Nova');
    expect(html).toContain('Night-owl astronomy grad student.');
    // hero falls back to the profile image when no visual identity is loaded
    expect(html).toContain('src="https://img.example/nova.png"');
  });

  it('exposes a View profile affordance when an open handler is provided', () => {
    const html = renderToStaticMarkup(<DiscoverCard character={nova} onOpen={() => {}} />);
    expect(html).toContain('View profile');
  });

  it('does not render online/premium badges unless the data supplies them', () => {
    const html = renderToStaticMarkup(<DiscoverCard character={nova} />);
    expect(html).not.toContain('Online');
    expect(html).not.toContain('Premium');
  });
});
