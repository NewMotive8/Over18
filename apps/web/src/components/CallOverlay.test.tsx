import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CallOverlay, { CallButton, formatRemaining, statusLine } from './CallOverlay';
import { IDLE_CALL_STATE, type CallState } from '../lib/voiceCall';

/**
 * What a person sees during a call.
 *
 * Static rendering, as every other component test in this repo does: the web
 * test environment is `node` with no DOM, so these assert the markup each state
 * produces rather than clicking through it. That is enough because the overlay
 * is a pure function of one state object -- all the behaviour lives in
 * `createCallController`, which has its own tests.
 */

const state = (over: Partial<CallState> = {}): CallState => ({ ...IDLE_CALL_STATE, ...over });
const render = (over: Partial<CallState> = {}) =>
  renderToStaticMarkup(
    <CallOverlay
      state={state(over)}
      characterName="Luna"
      onStart={() => {}}
      onHangUp={() => {}}
      onClose={() => {}}
    />,
  );

describe('the overlay appears only once a call starts', () => {
  it('renders nothing at all while idle', () => {
    expect(render()).toBe('');
  });

  it.each(['permission', 'connecting', 'active', 'ending', 'ended', 'error'] as const)(
    'renders a dialog in %s',
    (phase) => {
      const html = render({ phase });
      expect(html).toContain('role="dialog"');
      expect(html).toContain('Luna');
    },
  );
});

describe('each phase says what is happening', () => {
  it.each([
    ['permission', 'Allow microphone access'],
    ['connecting', 'Calling Luna'],
    ['ending', 'Ending the call'],
    ['ended', 'Call ended'],
    ['error', 'Call failed'],
  ] as const)('%s reads as "%s"', (phase, text) => {
    expect(render({ phase })).toContain(text);
  });

  it('distinguishes who is speaking while active', () => {
    expect(statusLine(state({ phase: 'active', characterSpeaking: true }), 'Luna')).toBe(
      'Luna is speaking…',
    );
    expect(statusLine(state({ phase: 'active', userSpeaking: true }), 'Luna')).toBe('Listening…');
    expect(statusLine(state({ phase: 'active' }), 'Luna')).toBe('Connected');
  });

  it('announces status changes to a screen reader', () => {
    expect(render({ phase: 'connecting' })).toContain('aria-live="polite"');
  });
});

describe('the time left', () => {
  it('is shown as minutes and seconds, not raw seconds', () => {
    expect(formatRemaining(780)).toBe('13:00');
    expect(formatRemaining(61)).toBe('1:01');
    expect(formatRemaining(9)).toBe('0:09');
    // Never a negative clock, whatever the arithmetic produces.
    expect(formatRemaining(-5)).toBe('0:00');
  });

  it('appears while active and not before', () => {
    expect(render({ phase: 'active', secondsRemaining: 780 })).toContain('13:00 left');
    expect(render({ phase: 'connecting', secondsRemaining: 780 })).not.toContain('left');
  });
});

describe('errors are shown in our own words', () => {
  it('renders the message as an alert', () => {
    const html = render({
      phase: 'error',
      message: 'Your browser blocked microphone access. Allow it in the address bar, then try again.',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('blocked microphone access');
  });

  it('shows no alert when there is nothing wrong', () => {
    expect(render({ phase: 'active' })).not.toContain('role="alert"');
  });
});

describe('the controls match the phase', () => {
  it.each(['permission', 'connecting', 'active'] as const)('offers End call in %s', (phase) => {
    const html = render({ phase });
    expect(html).toContain('End call');
    expect(html).not.toContain('Call again');
  });

  it.each(['ended', 'error'] as const)('offers Call again and Close in %s', (phase) => {
    const html = render({ phase });
    expect(html).toContain('Call again');
    expect(html).toContain('Close');
    expect(html).not.toContain('End call');
  });
});

describe('the call screen: her portrait, full screen, and one red button', () => {
  const withImage = (over: Partial<CallState> = {}) =>
    renderToStaticMarkup(
      <CallOverlay
        state={state(over)}
        characterName="Luna"
        characterImage="https://api.example/media/luna.png"
        onStart={() => {}}
        onHangUp={() => {}}
        onClose={() => {}}
      />,
    );

  it('fills the screen with her portrait, anchored at the top so her face stays in frame', () => {
    const html = withImage({ phase: 'active' });
    expect(html).toMatch(/<img[^>]*src="https:\/\/api\.example\/media\/luna\.png"[^>]*class="[^"]*inset-0[^"]*h-full[^"]*w-full[^"]*object-cover[^"]*object-top/);
  });

  it('without a portrait: a dark screen, never a broken image', () => {
    expect(render({ phase: 'active' })).not.toContain('<img');
  });

  it.each(['permission', 'connecting', 'active'] as const)('%s: the red round End call button is the ONLY control', (phase) => {
    const html = withImage({ phase });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-label="End call"[^>]*class="[^"]*rounded-full[^"]*bg-red-600/);
  });

  it('the conversation is heard, not printed: no transcript on the screen', () => {
    const html = withImage({
      phase: 'active',
      transcript: [
        { speaker: 'user', text: 'hello there' },
        { speaker: 'character', text: 'hello yourself' },
      ],
    });
    expect(html).not.toContain('hello there');
    expect(html).not.toContain('hello yourself');
    expect(html).not.toContain('<ul');
  });

  it('who is speaking is still said, in the status line', () => {
    expect(withImage({ phase: 'active', characterSpeaking: true })).toContain('Luna is speaking…');
  });
});

describe('the call button', () => {
  const button = (over: Partial<CallState> = {}) =>
    renderToStaticMarkup(
      <CallButton state={state(over)} characterName="Luna" onStart={() => {}} />,
    );

  /**
   * Asserted on the ATTRIBUTE, not the substring. The class list contains
   * `disabled:cursor-not-allowed`, so a bare `toContain('disabled')` passes
   * whether or not the button is actually disabled -- which is how the first
   * version of these three tests managed to be green and meaningless.
   */
  it('invites a call when idle', () => {
    const html = button();
    expect(html).toContain('aria-label="Call Luna"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('>Call</button>');
  });

  /**
   * Disabled during a call as well as guarded in the controller. The controller
   * is what makes a double-click safe; this is what stops the button looking
   * pressable when it would do nothing.
   */
  it.each(['permission', 'connecting', 'active', 'ending'] as const)('is disabled in %s', (phase) => {
    const html = button({ phase });
    expect(html).toContain('disabled=""');
    expect(html).toContain('On a call');
  });

  it.each(['ended', 'error'] as const)('is available again after %s', (phase) => {
    expect(button({ phase })).not.toContain('disabled=""');
  });
});
