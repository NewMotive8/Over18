import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { PublicPlayWithMeCard } from '../lib/api';
import {
  swipeDecisionFor,
  swipeProgress,
  TAP_SLOP_PX,
  type SwipeDecision,
} from '../lib/swipe';
import SwipeCard from './SwipeCard';

export interface SwipeDeckHandle {
  like: () => void;
  pass: () => void;
}

/**
 * Swipe deck (US-19).
 *
 * Renders the top discovery card with a natural drag gesture built on Pointer
 * Events (no gesture dependency added): drag right past a threshold → like, left
 * → pass, with live rotation and LIKE/PASS stamps as feedback. Releasing short
 * of the threshold springs the card back. A tap (no meaningful movement) opens
 * the profile.
 *
 * The same decisions are exposed imperatively via a ref so the desktop action
 * buttons and keyboard arrows produce an identical animated result — desktop is
 * never a second-class path. The next card peeks behind so the deck reads as a
 * stack.
 *
 * The deck is controlled: it animates the card out, THEN calls `onDecision`, so
 * the parent can advance its index only once the fling has played.
 *
 * THE CARDS ARE PLAY WITH ME CARDS. The deck used to take `PublicCharacter` —
 * the full roster shape, with no clip on it — and render `DiscoverCard`, which
 * then hunted for media through a fallback chain ending in a lettered tile.
 * It now takes the same card the Home rail renders, whose `clip` is a real
 * published video the server has already vouched for. The gesture code below is
 * untouched: this is a change of what the deck contains, not how it behaves.
 *
 * NOTHING HERE DECIDES A FAVOURITE. The deck reports 'like' or 'pass' and the
 * page maps that onto the stored relationship through `swipeAction`, so the
 * rule that a right swipe never removes a favourite lives in one testable
 * place rather than in a gesture handler.
 */
const SwipeDeck = forwardRef<
  SwipeDeckHandle,
  {
    current: PublicPlayWithMeCard;
    next?: PublicPlayWithMeCard;
    onDecision: (decision: SwipeDecision, character: PublicPlayWithMeCard) => void;
    onOpen: (character: PublicPlayWithMeCard) => void;
    disabled?: boolean;
  }
>(function SwipeDeck({ current, next, onDecision, onOpen, disabled = false }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [drag, setDrag] = useState({ dx: 0, dy: 0, dragging: false });
  const [fling, setFling] = useState<SwipeDecision | null>(null);

  // Synchronous pointer state. Kept in a ref (not React state) so a fast tap —
  // pointerdown + pointerup in a single tick, before any re-render — is still
  // seen as active in the pointerup handler and correctly opens the profile.
  const pointerRef = useRef({ active: false, x: 0, y: 0, moved: false });
  const committingRef = useRef(false);

  // Track the card width so thresholds and stamp progress scale to the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth || 320);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const commit = useCallback(
    (decision: SwipeDecision) => {
      const character = current;
      committingRef.current = false;
      setFling(null);
      setDrag({ dx: 0, dy: 0, dragging: false });
      onDecision(decision, character);
    },
    [current, onDecision],
  );

  const startFling = useCallback(
    (decision: SwipeDecision) => {
      if (disabled || committingRef.current) return;
      committingRef.current = true;
      setDrag((d) => ({ ...d, dragging: false }));
      setFling(decision);
      // Fallback in case transitionend doesn't fire (e.g. reduced motion).
      window.setTimeout(() => {
        if (committingRef.current) commit(decision);
      }, 360);
    },
    [disabled, commit],
  );

  useImperativeHandle(
    ref,
    () => ({
      like: () => startFling('like'),
      pass: () => startFling('pass'),
    }),
    [startFling],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || committingRef.current) return;
    pointerRef.current = { active: true, x: e.clientX, y: e.clientY, moved: false };
    setDrag({ dx: 0, dy: 0, dragging: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerRef.current.active) return;
    const dx = e.clientX - pointerRef.current.x;
    const dy = e.clientY - pointerRef.current.y;
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) pointerRef.current.moved = true;
    setDrag({ dx, dy, dragging: true });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerRef.current.active) return;
    pointerRef.current.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const dx = e.clientX - pointerRef.current.x;
    const moved = pointerRef.current.moved;
    setDrag({ dx: 0, dy: 0, dragging: false });

    if (!moved) {
      onOpen(current); // a tap, not a drag → open the profile
      return;
    }
    const decision = swipeDecisionFor(dx, width);
    if (decision) startFling(decision); // else: springs back to rest (dx reset above)
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || committingRef.current) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      startFling('pass');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      startFling('like');
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(current);
    }
  };

  // Derive the top card's transform.
  const flungDx = fling === 'like' ? width * 1.4 : fling === 'pass' ? -width * 1.4 : 0;
  const dx = fling ? flungDx : drag.dx;
  const dy = fling ? -40 : drag.dy * 0.12;
  const rotate = Math.max(-14, Math.min(14, (dx / Math.max(width, 1)) * 16));
  const opacity = fling ? 0 : 1;
  const dragging = drag.dragging;

  const progress = swipeProgress(dx, width);
  const likeOpacity = fling === 'like' ? 1 : dx > 0 ? progress : 0;
  const passOpacity = fling === 'pass' ? 1 : dx < 0 ? progress : 0;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none"
      tabIndex={0}
      role="group"
      aria-label={`Discovering ${current.displayName}. Swipe or use arrow keys: left to pass, right to like, Enter to open profile.`}
      onKeyDown={onKeyDown}
    >
      {/* Peek of the next card behind the top card. */}
      {next && (
        <div aria-hidden className="pointer-events-none absolute inset-0 scale-[0.94] opacity-60">
          <SwipeCard character={next} />
        </div>
      )}

      {/* Top (interactive) card. Keyed by id so a new card mounts fresh at rest. */}
      <div
        key={current.id}
        className="absolute inset-0 touch-none"
        style={{
          transform: `translate3d(${dx}px, ${dy}px, 0) rotate(${rotate}deg)`,
          opacity,
          transition: dragging
            ? 'none'
            : 'transform 280ms cubic-bezier(.2,.7,.3,1), opacity 280ms ease',
          cursor: dragging ? 'grabbing' : 'grab',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'transform' && fling && committingRef.current) commit(fling);
        }}
      >
        <SwipeCard character={current} onOpen={() => onOpen(current)} />

        {/* Gesture feedback stamps. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-5 top-5 -rotate-12 rounded-lg border-4 border-emerald-400 px-3 py-1 text-2xl font-black uppercase tracking-wider text-emerald-400"
          style={{ opacity: likeOpacity }}
        >
          Like
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute right-5 top-5 rotate-12 rounded-lg border-4 border-rose-500 px-3 py-1 text-2xl font-black uppercase tracking-wider text-rose-500"
          style={{ opacity: passOpacity }}
        >
          Pass
        </div>
      </div>
    </div>
  );
});

export default SwipeDeck;
