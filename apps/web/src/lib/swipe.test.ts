import { describe, it, expect } from 'vitest';
import {
  COMMIT_MIN_PX,
  commitThreshold,
  swipeDecisionFor,
  swipeProgress,
} from './swipe';

describe('swipe thresholds', () => {
  it('scales the commit threshold with card width but never below the floor', () => {
    expect(commitThreshold(1000)).toBe(280); // 1000 * 0.28
    expect(commitThreshold(100)).toBe(COMMIT_MIN_PX); // floor wins on tiny cards
  });
});

describe('swipeDecisionFor', () => {
  const width = 400; // threshold = 112px
  it('commits like when dragged right past the threshold', () => {
    expect(swipeDecisionFor(200, width)).toBe('like');
  });
  it('commits pass when dragged left past the threshold', () => {
    expect(swipeDecisionFor(-200, width)).toBe('pass');
  });
  it('does not commit for a short drag', () => {
    expect(swipeDecisionFor(40, width)).toBeNull();
    expect(swipeDecisionFor(-40, width)).toBeNull();
    expect(swipeDecisionFor(0, width)).toBeNull();
  });
});

describe('swipeProgress', () => {
  it('reports 0..1 progress toward the threshold and clamps at 1', () => {
    const width = 400; // threshold = 112
    expect(swipeProgress(0, width)).toBe(0);
    expect(swipeProgress(56, width)).toBeCloseTo(0.5, 5);
    expect(swipeProgress(1000, width)).toBe(1);
    expect(swipeProgress(-1000, width)).toBe(1);
  });
});
