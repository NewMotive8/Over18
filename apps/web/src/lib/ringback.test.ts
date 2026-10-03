import { afterEach, describe, expect, it, vi } from 'vitest';
import { RING_CYCLE_MS, RING_FREQUENCIES_HZ, RING_GAIN, RING_ON_MS, createBrowserRingback } from './ringback';

/**
 * The ringback tone, against a fake AudioContext (the web tests run in node).
 * It must ring the standard pattern, quietly, and go silent on stop.
 */

class FakeContext {
  static made: FakeContext[] = [];
  currentTime = 0;
  closed = false;
  destination = {};
  oscillators: { frequency: { value: number }; start: number; stop: number }[] = [];
  gains: number[] = [];
  constructor() {
    FakeContext.made.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createGain() {
    const ctx = this;
    return {
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: (v: number) => ctx.gains.push(v),
      },
      connect: () => {},
    };
  }
  createOscillator() {
    const osc = { frequency: { value: 0 }, start: -1, stop: -1 };
    this.oscillators.push(osc);
    return {
      frequency: osc.frequency,
      connect: () => {},
      start: (t: number) => (osc.start = t),
      stop: (t: number) => (osc.stop = t),
    };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeContext.made = [];
});

describe('the ringback tone', () => {
  it('rings 440 + 480 Hz for two seconds, quietly, the moment it starts', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    vi.useFakeTimers();
    const ring = createBrowserRingback();
    ring.start();
    const ctx = FakeContext.made[0]!;
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([...RING_FREQUENCIES_HZ]);
    for (const o of ctx.oscillators) expect(o.stop - o.start).toBeCloseTo(RING_ON_MS / 1000);
    expect(Math.max(...ctx.gains)).toBe(RING_GAIN);
    expect(RING_GAIN).toBeLessThanOrEqual(0.1);
    ring.stop();
  });

  it('rings again every cycle until stopped, then is silent and closed', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    vi.useFakeTimers();
    const ring = createBrowserRingback();
    ring.start();
    const ctx = FakeContext.made[0]!;
    vi.advanceTimersByTime(RING_CYCLE_MS * 2);
    expect(ctx.oscillators).toHaveLength(RING_FREQUENCIES_HZ.length * 3);
    ring.stop();
    expect(ctx.closed).toBe(true);
    vi.advanceTimersByTime(RING_CYCLE_MS * 3);
    expect(ctx.oscillators).toHaveLength(RING_FREQUENCIES_HZ.length * 3);
  });

  it('start twice makes one ring; stop is safe any number of times', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    vi.useFakeTimers();
    const ring = createBrowserRingback();
    ring.start();
    ring.start();
    expect(FakeContext.made).toHaveLength(1);
    ring.stop();
    ring.stop();
  });

  it('no audio in this browser: no ring, and no error', () => {
    const ring = createBrowserRingback();
    expect(() => ring.start()).not.toThrow();
    expect(() => ring.stop()).not.toThrow();
  });
});
