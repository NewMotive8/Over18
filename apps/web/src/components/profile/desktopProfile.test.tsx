import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicCharacter } from '@over18/shared';
import { characterHeaderItems, type CharacterClipRef } from '../../lib/media';
import ProfileHero from './ProfileHero';
import ProfileIdentity from './ProfileIdentity';

/**
 * Desktop Pass 2: the character profile.
 *
 * Two columns from `lg` -- her media on the left, identity / actions /
 * relationship / tabs on the right -- built with CSS on ONE DOM. Below `lg` the
 * phone layout is exactly what it was.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const character = (): PublicCharacter => ({
  id: 'c1', name: 'aria', displayName: 'Aria', profileImage: null, shortBio: '', personality: '', interests: [], conversationStyle: '',
});
const clip = (id: string): CharacterClipRef => ({ id, mediaType: 'video', url: `/api/media/assets/${id}/file` });
const hero = (clips: CharacterClipRef[], topRight?: JSX.Element) =>
  renderToStaticMarkup(
    <ProfileHero items={characterHeaderItems(character(), clips, null)} name="Aria" age={24} onBack={() => {}} onOpen={() => {}} topRight={topRight} />,
  );

describe('the phone profile is unchanged', () => {
  const html = hero([clip('v1'), clip('v2')], <span>pill</span>);

  it('the hero keeps its full-bleed band, 4:5 slides, swipe scroller and dots', () => {
    expect(html).toContain('relative overflow-hidden rounded-b-3xl');
    expect(html).toContain('relative aspect-[4/5] w-full shrink-0 snap-center bg-zinc-900');
    expect(html).toContain('flex snap-x snap-mandatory overflow-x-auto');
    expect(html).toContain('absolute left-1/2 top-14 flex -translate-x-1/2 gap-1.5');
  });

  it('the identity overlay and the hero’s Credits slot are still there below lg', () => {
    expect(html).toContain('absolute inset-x-0 bottom-0 flex items-end gap-3 p-4');
    expect(html).toContain('>Aria</h1>');
    expect(html).toContain('pill');
  });

  it('the page is a single column below lg: the grid, the sticky column and the gaps are all lg-only', () => {
    const page = read('../../pages/CharacterDetailPage.tsx');
    expect(page).toContain('className="flex flex-col pb-10 lg:grid ');
    expect(page).toContain('<div className="flex flex-col gap-4 px-4 pt-4 lg:gap-5 lg:px-0 lg:pt-0">');
    expect(page).toContain('<div className="lg:sticky lg:top-24">');
  });

  it('the posts grid is still two columns on a phone', () => {
    expect(read('./PostsTab.tsx')).toContain('<div className="grid grid-cols-2 gap-3 lg:grid-cols-3">');
  });
});

describe('the desktop profile', () => {
  it('the page: media left (5fr), details right (6fr), the media staying in view', () => {
    const page = read('../../pages/CharacterDetailPage.tsx');
    expect(page).toContain('lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-10');
    expect(page).toContain('lg:sticky lg:top-24');
  });

  it('uses the desktop frame rather than the phone column', () => {
    expect(read('../AppShell.tsx')).toMatch(/isProfile\s*\?\s*'max-w-lg lg:max-w-6xl lg:overflow-visible lg:px-8'/);
  });

  it('the media column can really stick: <main> does not clip on the desktop profile', () => {
    // `overflow-y-auto` on <main> would make it the sticky reference box even
    // though the document scrolls, leaving the column offset and not sticking.
    const shell = read('../AppShell.tsx');
    expect(shell).toContain('lg:overflow-visible');
    // Only the profile's desktop frame carries it.
    expect(shell.split("lg:overflow-visible lg:px-8'").length - 1).toBe(1);
  });

  it('the hero becomes a card, with arrows for a mouse', () => {
    const html = hero([clip('v1'), clip('v2')]);
    expect(html).toContain('lg:rounded-3xl lg:border lg:border-white/10');
    expect(html).toMatch(/data-testid="profile-hero-prev"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/);
    expect(html).toMatch(/data-testid="profile-hero-next"[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b/);
  });

  it('a single media item needs no arrows', () => {
    expect(hero([clip('v1')])).not.toContain('profile-hero-next');
  });

  it('her identity heads the right column on a desktop, and the overlay steps aside -- never both', () => {
    const html = hero([clip('v1')], <span>pill</span>);
    expect(html).toContain('absolute inset-x-0 bottom-0 flex items-end gap-3 p-4 lg:hidden');
    const identity = renderToStaticMarkup(<ProfileIdentity name="Aria" age={24} />);
    expect(identity).toMatch(/data-testid="profile-identity-desktop"[^>]*class="hidden [^"]*lg:flex"/);
  });

  it('the desktop identity shows the same content as the overlay, nothing added', () => {
    const identity = renderToStaticMarkup(<ProfileIdentity name="Aria" age={24} avatarPoster="https://img/a.png" />);
    const overlay = hero([clip('v1')]);
    for (const text of ['Aria', '24', 'VIP', 'Online now']) {
      expect(identity).toContain(text);
      expect(overlay).toContain(text);
    }
    expect(identity).toContain('https://img/a.png');
    // Only what the overlay says: a name, an age, the badge and the status.
    expect(identity.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toBe('Aria 24 VIP Online now');
  });

  it('the hero’s own Credits pill and lower gradient are phone-only: the desktop header carries the balance', () => {
    const html = hero([clip('v1')], <span>pill</span>);
    expect(html).toContain('rounded-xl bg-black/40 backdrop-blur lg:hidden');
    expect(html).toContain('via-zinc-950/40 to-transparent lg:hidden');
  });
});

describe('one DOM: nothing functional is rendered twice', () => {
  const page = read('../../pages/CharacterDetailPage.tsx');
  const count = (needle: string) => page.split(needle).length - 1;

  it('the Posts tab, the actions, the tabs, the tracker and the viewers each appear once', () => {
    // PostsTab resumes an unlock from the URL and reports locked content once;
    // a second mount would do both twice.
    for (const tag of ['<PostsTab', '<AboutTab', '<ProfileActions', '<ProfileTabs', '<RelationshipTracker', '<ProfileHero', '<MediaViewer', '<PremiumFunnel']) {
      expect(count(tag), tag).toBe(1);
    }
  });

  it('the actions keep their rules: the server-decided Premium button, Chat and Call', () => {
    expect(page).toContain('onUpgrade={upgrade ?? undefined}');
    expect(page).toContain('onChat={() => startChat(character)}');
    expect(page).toContain('onCall={() => startCall(character)}');
  });

  it('the unlock-resume wiring is untouched', () => {
    expect(page).toContain('resumeUnlockAssetId={resumeUnlock}');
    expect(page).toContain("next.delete('unlock');");
  });
});
