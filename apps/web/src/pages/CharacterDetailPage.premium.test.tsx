import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerEconomyOverview, CustomerEconomyState } from '../lib/customerEconomy';
import ProfileActions from '../components/profile/ProfileActions';
import { upgradeAction } from './CharacterDetailPage';

/**
 * A character profile's Premium button.
 *
 * It used to show to everyone -- Premium members included -- and open a
 * placeholder sheet ("Payments are not enabled in this preview") that sent
 * people to /subscription. Now the server's tier decides whether there is a
 * button at all, and a Free customer gets the real Premium funnel.
 */

const ready = (tier: 'free' | 'premium'): CustomerEconomyState => ({
  status: 'ready',
  overview: { commercial: { tier: { available: true, value: tier } } } as unknown as CustomerEconomyOverview,
});
const actions = () => ({ openFunnel: vi.fn(), signIn: vi.fn() });

describe('who gets the Premium button', () => {
  it('a Premium member: no button at all', () => {
    expect(upgradeAction(ready('premium'), actions())).toBeNull();
  });

  it('a Free customer: the real Premium funnel', () => {
    const a = actions();
    upgradeAction(ready('free'), a)!();
    expect(a.openFunnel).toHaveBeenCalledTimes(1);
    expect(a.signIn).not.toHaveBeenCalled();
  });

  it('a signed-out visitor: sign in first, as Chat does', () => {
    const a = actions();
    upgradeAction({ status: 'signed-out', message: '' }, a)!();
    expect(a.signIn).toHaveBeenCalledTimes(1);
    expect(a.openFunnel).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'loading' },
    { status: 'disabled', message: '' },
    { status: 'unavailable', message: '' },
    { status: 'error', message: '' },
  ] as CustomerEconomyState[])('$status: no button (never flashed at a member)', (state) => {
    expect(upgradeAction(state, actions())).toBeNull();
  });

  it('a tier the server has not made available is not treated as Free', () => {
    const unknownTier = {
      status: 'ready',
      overview: { commercial: { tier: { available: false } } } as unknown as CustomerEconomyOverview,
    } as CustomerEconomyState;
    expect(upgradeAction(unknownTier, actions())).toBeNull();
  });
});

describe('the action row', () => {
  const row = (onUpgrade?: () => void) =>
    renderToStaticMarkup(<ProfileActions onUpgrade={onUpgrade} onChat={() => {}} onCall={() => {}} />);

  it('without an upgrade action there is no Premium button; Chat and Call remain', () => {
    const html = row();
    expect(html).not.toContain('Premium');
    expect(html).toContain('Chat');
    expect(html).toContain('aria-label="Call"');
  });

  it('with one, the Premium button is there', () => {
    expect(row(() => {})).toContain('Premium');
  });
});

describe('the profile opens the real funnel, not the placeholder', () => {
  const page = readFileSync(new URL('./CharacterDetailPage.tsx', import.meta.url), 'utf8');

  it('renders PremiumFunnel straight on the offer, reported as the premium_gate surface', () => {
    expect(page).toMatch(/<PremiumFunnel[^>]*surface="premium_gate"[^>]*startAt="plans"/);
  });

  it('the placeholder sheet and its /subscription redirect are gone', () => {
    expect(page).not.toMatch(/components\/PremiumGate/);
    expect(page).not.toMatch(/['"]\/subscription['"]/);
  });
});

describe('a funnel opened on the offer', () => {
  const funnel = readFileSync(new URL('../components/premium/PremiumFunnel.tsx', import.meta.url), 'utf8');

  it('starts at the step it was asked for, and Back closes it instead of showing the feed-allowance intro', () => {
    expect(funnel).toMatch(/useState<'intro' \| 'plans'>\(startAt\)/);
    expect(funnel).toMatch(/setStep\(startAt\)/);
    expect(funnel).toMatch(/onBack=\{\(\) => \(startAt === 'plans' \? close\(\) : setStep\('intro'\)\)\}/);
  });
});
