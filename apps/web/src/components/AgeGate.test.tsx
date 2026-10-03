import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgeGate from './AgeGate';

/**
 * What a visitor meets at the door.
 *
 * Static rendering, as every other component test here does: the web test
 * environment is node with no DOM, so these assert the markup each state
 * produces. The gate is a pure function of one status, which is what makes that
 * enough.
 */

const asking = () =>
  renderToStaticMarkup(
    <AgeGate status="asking" onConfirm={() => {}} onDecline={() => {}} onBack={() => {}} />,
  );
const declined = () =>
  renderToStaticMarkup(
    <AgeGate status="declined" onConfirm={() => {}} onDecline={() => {}} onBack={() => {}} />,
  );

describe('the question', () => {
  it('warns before it asks', () => {
    const html = asking();
    expect(html).toContain('18+ only');
    expect(html).toContain('sexually explicit material');
    expect(html).toContain('adults aged 18 or over');
  });

  it('offers an affirmative action and a way out', () => {
    const html = asking();
    expect(html).toContain('I am 18 or over');
    expect(html).toContain('I am under 18');
  });

  it('is announced as a dialog with a name and a description', () => {
    const html = asking();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="age-gate-title"');
    expect(html).toContain('aria-describedby="age-gate-body"');
  });

  /** Both controls are buttons, so they are reachable and operable by keyboard. */
  it('uses real buttons, not clickable divs', () => {
    expect(asking().match(/<button type="button"/g)).toHaveLength(2);
  });

  /**
   * THE HONESTY LINE. A confident-looking gate invites the inference that
   * something was checked. Nothing was, and the screen says so.
   */
  it('says plainly that nothing is verified', () => {
    expect(asking()).toContain('self-declared');
    expect(asking()).toContain('Nothing is verified');
  });

  /** The characters are AI, and the door is where that is first said. */
  it('discloses that the characters are AI-generated', () => {
    const html = asking();
    expect(html).toContain('AI-generated');
    expect(html).toContain('no real person is depicted');
  });
});

describe('someone under eighteen', () => {
  it('is refused, and shown no content', () => {
    const html = declined();
    expect(html).toContain('You cannot enter this site');
    expect(html).not.toContain('I am 18 or over');
  });

  it('is told as an alert, not as ordinary text', () => {
    expect(declined()).toContain('role="alert"');
  });

  /** A mis-tap must not be a wall: one clearly labelled way back. */
  it('can return to the question', () => {
    expect(declined()).toContain('Go back');
  });

  /**
   * NO INVENTED DESTINATION. Sending somebody to some other website would mean
   * choosing one for them, and an invented link is worse than an honest dead
   * end they can close.
   */
  it('links nowhere off the site', () => {
    expect(declined()).not.toContain('href=');
  });
});

/**
 * THE WHOLE POINT, ASSERTED. Neither state may carry anything from the
 * application: no character, no clip, no media element.
 */
describe('nothing adult is rendered either way', () => {
  it.each([
    ['asking', asking],
    ['declined', declined],
  ])('renders no media or character content while %s', (_label, render) => {
    const html = render();
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/api/');
  });
});
