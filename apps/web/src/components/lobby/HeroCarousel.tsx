import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PublicClip } from '../../lib/api';
import ClipMedia from './ClipMedia';

/**
 * The Hero carousel (US-102.4).
 *
 * ADMIN-ASSIGNED CLIPS ONLY. The server sends exactly the clips an operator put
 * here, in their order. There is no performance input anywhere in this path —
 * this product records no views or plays, and the ticket says the
 * editorial/performance mixing rule is still unspecified, so nothing here
 * pretends to rank.
 *
 * The previous version composed its own slides: a hard-coded "Refer a friend,
 * get 85% off" promo plus the first three characters, with invented eyebrow and
 * headline copy. None of it was CMS-controlled. It is gone — an empty Hero now
 * renders nothing, which is the honest state when an operator has assigned no
 * clips.
 *
 * Native scroll-snap for paging, as before, so a natural horizontal swipe works
 * and the layout stays usable on desktop.
 */
/**
 * The distance from one slide's start to the next: the slide width plus the
 * gap. On a phone that is the scroller's own width (one slide fills it, no
 * gap), exactly what the index used to be computed from; on a desktop several
 * portrait slides share the row, so it is measured from the slides themselves
 * rather than assumed from a breakpoint.
 */
function slideStep(el: HTMLElement): number {
  const first = el.children[0] as HTMLElement | undefined;
  const second = el.children[1] as HTMLElement | undefined;
  const step = first && second ? second.offsetLeft - first.offsetLeft : 0;
  return step > 0 ? step : el.clientWidth;
}

export default function HeroCarousel({ clips }: { clips: PublicClip[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** The first slide in view. */
  const [active, setActive] = useState(0);
  /** How many slides are in view at once: 1 on a phone, 3-4 on a desktop. */
  const [perView, setPerView] = useState(1);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setPerView(Math.max(1, Math.round(el.clientWidth / slideStep(el))));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clips.length]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / slideStep(el));
    if (i !== active) setActive(i);
  };

  const goTo = (i: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * slideStep(el), behavior: 'smooth' });
  };

  if (clips.length === 0) return null;
  const lastStart = Math.max(0, clips.length - perView);
  /**
   * The desktop row never shows an empty slot: 4 across from xl only when
   * there are 4 or more clips to fill it (an operator may assign just 3 -- the
   * fallback is 3), and fewer than 3 are centred rather than left-aligned.
   */
  const desktopRow = `${clips.length >= 4 ? 'xl:w-[calc((100%-3rem)/4)]' : ''}`;
  const desktopAlign = clips.length < 3 ? 'lg:justify-center' : '';

  return (
    <section aria-label="Featured" className="relative">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className={`flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:gap-4 ${desktopAlign}`}
      >
        {/*
          SQUARE, NOT 16:11 -- the banner ZOOMS OUT rather than cropping harder.

          Every clip in production is portrait: measured 9:16 (0.5625),
          640x1152 (0.5556), 544x960 (0.5667) and 768x1168 (0.6575). A 16:11
          band shows only 39% of a 9:16 clip's height, and `object-cover` split
          that loss evenly, so 30.7% came off the TOP -- exactly where the face
          is. On the live Home page Camila and Karen were both cropped to a chin.

          Re-anchoring the crop alone was tried and rejected: it rescues the head
          but leaves a head-and-shoulders sliver, which is not what a hero should
          show. Making the frame taller is the actual fix -- 1:1 shows 56% of the
          clip instead of 39%, so the whole subject reads, head and torso.

          WHY 1:1 AND NOT TALLER. 4:5 and 3:4 show still more, and at 375px wide
          they are 469px and 500px tall: the "Play with me" rail below drops off
          the first screen. A square hero is 375px, keeps the rail visible, and
          is still a 45% gain in visible clip. It is also the largest ratio that
          never letterboxes -- wider than every clip, so `object-cover` fills it
          edge to edge with no side gutters at any viewport width.
        */}
        {/*
          DESKTOP (lg+): PORTRAIT, SEVERAL AT ONCE. A square as wide as a
          desktop container would be 1200px tall; a wide band would crop the
          faces the square was chosen to protect. Every clip is portrait, so
          the desktop row shows 3 (lg) or 4 (xl+) 3:4 slides side by side --
          more of each clip than the phone's square, and more characters in
          the first screen. The phone keeps the square above, untouched.
        */}
        {clips.map((clip, i) => (
          <div
            key={clip.id}
            className={`relative aspect-square w-full shrink-0 snap-center lg:aspect-[3/4] lg:w-[calc((100%-2rem)/3)] lg:snap-start lg:overflow-hidden lg:rounded-3xl ${desktopRow}`}
          >
            <div className="absolute inset-0">
              {/* ONLY THE ACTIVE SLIDE PLAYS. All three used to autoplay at
                  once: measured at readyState=4 with slides 2 and 3 decoding
                  off screen. `active` stops the decode; the neighbouring slide
                  still LOADS via ClipMedia's viewport margin, so swiping to it
                  finds bytes already arriving. Dimensions, crop, gradient,
                  overlay and scroll-snap are untouched. */}
              {/*
                THE REMAINING CROP COMES OFF THE BOTTOM.

                A square frame still discards ~44% of a 9:16 clip, and centring
                that would take 21.9% off the top -- enough to cut a face on
                content framed as tightly as Camila's. Anchoring at 12% takes
                5.3% from the top and the rest from the floor, which is what
                nobody is looking at.

                12% RATHER THAN 0%. Top-aligning wastes the frame on clips that
                carry headroom above the subject; 12% keeps a little of it and
                still clears the head on the tightest clip in production.
                Verified on all three assigned hero clips.

                THE OVERRIDE LIVES HERE, NOT IN ClipMedia. `className` is the
                prop that component already exposes for this (FeedView uses it
                for `object-contain`), so the shared default is untouched and no
                other surface -- the clip grid, the rails, Posts, Play with me --
                changes at all. The right framing depends on the frame's shape,
                and only the caller knows that.
              */}
              <ClipMedia
                clip={clip}
                autoPlay
                active={i >= active && i < active + perView}
                className="h-full w-full object-cover object-[center_12%]"
              />
            </div>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 p-5">
              <h2 className="max-w-[16rem] text-2xl font-black leading-tight tracking-tight text-white drop-shadow">
                {clip.characterName}
              </h2>
              <Link
                to={`/characters/${clip.characterId}`}
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 text-sm font-bold text-zinc-950 shadow-lg transition-transform active:scale-95"
              >
                Say hello <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: arrows, since a mouse cannot swipe. Shown only when there is
          more than fits in the row. The phone keeps its dots. */}
      {clips.length > perView && (
        <>
          <button
            type="button"
            aria-label="Previous featured"
            data-testid="hero-prev"
            disabled={active <= 0}
            onClick={() => goTo(Math.max(0, active - 1))}
            className="absolute left-3 top-1/2 z-10 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-zinc-950/70 text-2xl text-white shadow-lg shadow-black/40 backdrop-blur transition-opacity hover:bg-zinc-900 disabled:pointer-events-none disabled:opacity-0 lg:flex"
          >
            <span aria-hidden>‹</span>
          </button>
          <button
            type="button"
            aria-label="Next featured"
            data-testid="hero-next"
            disabled={active >= lastStart}
            onClick={() => goTo(Math.min(lastStart, active + 1))}
            className="absolute right-3 top-1/2 z-10 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-zinc-950/70 text-2xl text-white shadow-lg shadow-black/40 backdrop-blur transition-opacity hover:bg-zinc-900 disabled:pointer-events-none disabled:opacity-0 lg:flex"
          >
            <span aria-hidden>›</span>
          </button>
        </>
      )}

      {clips.length > 1 && (
        <div className="absolute right-4 top-4 flex gap-1.5 lg:hidden">
          {clips.map((clip, i) => (
            <button
              key={clip.id}
              type="button"
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === active}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === active ? 'w-6 bg-white' : 'w-2 bg-white/40'
              }`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
