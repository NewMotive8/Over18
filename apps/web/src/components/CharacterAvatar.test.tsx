import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CharacterAvatar from './CharacterAvatar';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('a character avatar', () => {
  it('frames her portrait from the top, so a tall picture never loses her head to the circle', () => {
    const html = renderToStaticMarkup(<CharacterAvatar name="Jenna" src="https://img/jenna.jpg" size="lg" />);
    expect(html).toContain('src="https://img/jenna.jpg"');
    expect(html).toContain('object-cover object-top');
    expect(html).toContain('rounded-full');
    expect(html).toContain('overflow-hidden');
  });

  it('shows her initial when she has no portrait', () => {
    const html = renderToStaticMarkup(<CharacterAvatar name=" karen" size="md" />);
    expect(html).not.toContain('<img');
    expect(html).toContain('>K<');
  });

  it('is the one avatar: her profile (phone and desktop) and the chat header all use it', () => {
    for (const file of ['./profile/ProfileIdentity.tsx', './profile/ProfileHero.tsx', '../pages/ChatPage.tsx']) {
      const source = read(file);
      expect(source, file).toContain('<CharacterAvatar ');
      expect(source, file).not.toMatch(/rounded-full[^"]*object-cover|<img src=\{avatar/);
    }
  });
});
