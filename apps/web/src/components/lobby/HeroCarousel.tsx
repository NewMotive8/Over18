import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HeroSlide } from '../../lib/lobbyContent';
import { resolveHeroMedia } from '../../lib/media';
import { useCharacterVisual } from '../../hooks/useCharacterVisual';
import HeroMedia from '../HeroMedia';

/** Media/gradient backdrop for one hero slide. */
function HeroBackdrop({ slide }: { slide: HeroSlide }) {
  const { visual } = useCharacterVisual(slide.character?.id ?? '');
  if (slide.kind === 'persona' && slide.character) {
    return <HeroMedia media={resolveHeroMedia(slide.character, visual)} alt={slide.character.displayName} />;
  }
  // Promo slide: a rich brand gradient (no persona media).
  return <div className="h-full w-full bg-gradient-to-br from-fuchsia-700 via-rose-600 to-orange-500" />;
}

/**
 * Full-width hero carousel (US-28 / v2 brief §1).
 *
 * A dominant, edge-to-edge media hero with a dark gradient for legibility, a
 * bold headline, a primary CTA, and pagination indicators. Uses native
 * scroll-snap so paging works with a natural horizontal swipe and stays usable
 * on desktop; the active dot tracks scroll position.
 */
export default function HeroCarousel({ slides }: { slides: HeroSlide[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== active) setActive(i);
  };

  const goTo = (i: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  if (slides.length === 0) return null;

  return (
    <section aria-label="Featured" className="relative">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {slides.map((slide) => (
          <div key={slide.id} className="relative aspect-[16/11] w-full shrink-0 snap-center">
            <div className="absolute inset-0">
              <HeroBackdrop slide={slide} />
            </div>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 p-5">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white backdrop-blur">
                {slide.eyebrow}
              </span>
              <h2 className="max-w-[16rem] text-2xl font-black leading-tight tracking-tight text-white drop-shadow">
                {slide.headline}
              </h2>
              <p className="line-clamp-1 max-w-xs text-sm text-zinc-200/90">{slide.sub}</p>
              <Link
                to={slide.ctaTo}
                className="mt-1 inline-flex items-center gap-1 rounded-full bg-white px-4 py-2 text-sm font-bold text-zinc-950 shadow-lg transition-transform active:scale-95"
              >
                {slide.ctaLabel} <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <div className="absolute right-4 top-4 flex gap-1.5">
          {slides.map((slide, i) => (
            <button
              key={slide.id}
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
