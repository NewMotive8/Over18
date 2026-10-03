import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CustomerEconomyOverview } from '../lib/customerEconomy';
import { CreditBalance } from './CustomerEconomy';

/**
 * Persistent Credits balance + one-tap top-up (store-conversion PR).
 *
 * The balance is the server's, shown across the signed-in app, and ONE tap on
 * it opens the Credits Store -- no account menu first. After a purchase or a
 * spend every balance on screen asks the server again.
 */

const src = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(src, rel), 'utf8');

const overview = (spendable: number | null) =>
  ({
    commercial: {
      wallet: spendable === null ? { available: false, reason: 'wallet_not_supported' } : { available: true, value: { spendable } },
    },
  }) as unknown as CustomerEconomyOverview;
const render = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('the balance control', () => {
  it('is one link to /credits with the server balance', () => {
    const html = render(<CreditBalance overview={overview(1250)} compact />);
    expect(html).toMatch(/<a[^>]*href="\/credits"/);
    expect(html).toContain('data-testid="credits-balance"');
    expect(html).toContain('aria-label="1250 Credits available. View your Credits."');
    expect(html).toContain('1,250');
    expect(html).toContain(' Credits');
  });

  it('tight (crowded headers): the word "Credits" hides on a narrow phone, the number never does', () => {
    const html = render(<CreditBalance overview={overview(80)} compact tight />);
    expect(html).toMatch(/80<span class="hidden sm:inline"> Credits<\/span>/);
  });

  it('nothing at all -- never a zero -- while the server has not stated a balance', () => {
    expect(render(<CreditBalance overview={overview(null)} />)).toBe('');
  });
});

describe('where the balance is shown', () => {
  it('the app bar on ordinary screens (the store, Premium, Favourites, Profile, chat)', () => {
    expect(read('components/AppShell.tsx')).toMatch(/<CreditsPill \/>/);
  });

  it('the lobby top bar -- tight, so it fits beside the existing actions', () => {
    expect(read('components/lobby/LobbyTopBar.tsx')).toMatch(/<CreditsPill tight \/>/);
  });

  it("a character's profile, opposite Back -- and her Posts tab", () => {
    expect(read('pages/CharacterDetailPage.tsx')).toMatch(/topRight=\{<CreditsPill \/>\}/);
    expect(read('components/profile/ProfileHero.tsx')).toMatch(/topRight &&/);
    expect(read('components/profile/PostsTab.tsx')).toMatch(/<CreditBalance overview=\{economy\.overview\} compact \/>/);
  });

  it('chat -- as the self-refreshing pill, not a balance read once', () => {
    const chat = read('pages/ChatPage.tsx');
    expect(chat).toMatch(/<CreditsPill \/>/);
    expect(chat).not.toMatch(/<CreditBalance /);
  });
});

describe('the balance cannot go stale', () => {
  it('the pill re-reads on navigation, on a purchase or spend, and on return to the tab', () => {
    const pill = read('components/CreditsPill.tsx');
    expect(pill).toMatch(/\[pathname, refresh\]/);
    expect(pill).toMatch(/CREDITS_CHANGED_EVENT/);
    expect(pill).toMatch(/visibilitychange/);
  });

  it('a purchase, an unlock and a call each announce that Credits changed', () => {
    expect(read('pages/CreditsStorePage.tsx')).toMatch(/announceCreditsChanged\(\)/);
    expect(read('components/profile/PostsTab.tsx')).toMatch(/onUnlocked: \(\) => \{[\s\S]*?announceCreditsChanged\(\)/);
    expect(read('lib/voiceCall.ts')).toMatch(/announceCreditsChanged\(\)/);
  });
});

describe('the Credits Store is a checkout on a phone', () => {
  it('the app navigation steps aside on /credits on a phone only -- desktop keeps it', () => {
    const shell = read('components/AppShell.tsx');
    expect(shell).toMatch(/const hideNavOnPhone = pathname === '\/credits';/);
    expect(shell).toMatch(/hideNavOnPhone \? 'hidden lg:block' : ''/);
  });

  it('the page reserves room for the sticky bar, and the bar steps aside while paying', () => {
    const page = read('pages/CreditsStorePage.tsx');
    expect(page).toMatch(/pb-28 lg:pb-0/);
    expect(page).toMatch(/\{shopping && !paying && <StickyPurchaseBar/);
  });
});
