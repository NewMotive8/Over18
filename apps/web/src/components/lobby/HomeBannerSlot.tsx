import { Link } from 'react-router-dom';
import { API_URL, type PublicHomeBanner } from '../../lib/api';
import { bannerHref } from '../../lib/homeContent';

/**
 * One of the two Home banner slots (US-102.4).
 *
 * WHAT THIS IS NOT: the "Get 20 For Free" component. That stays exactly where
 * it is, in the discovery grid, as its own separate thing — the ticket says so
 * explicitly and it is not a CMS banner.
 *
 * The slot renders every eligible banner the server put in it, in the order the
 * operator set. Eligibility — status, schedule, audience, dependency health —
 * was decided server-side by US-102.3; nothing is re-judged here, so the
 * component cannot show something the API considered ineligible.
 *
 * Renders nothing at all when its slot is empty, so an unused slot occupies no
 * space rather than leaving a gap.
 */
export default function HomeBannerSlot({
  banners,
  label,
}: {
  banners: PublicHomeBanner[];
  label: string;
}) {
  if (banners.length === 0) return null;

  return (
    <section aria-label={label} className="flex flex-col gap-3 px-4">
      {banners.map((banner) => (
        <BannerCard key={banner.id} banner={banner} />
      ))}
    </section>
  );
}

function BannerCard({ banner }: { banner: PublicHomeBanner }) {
  const href = bannerHref(banner);
  const external = href?.startsWith('http');

  const body = (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl border border-white/5 bg-zinc-900">
      {banner.creativeUrl ? (
        banner.creativeMediaType === 'video' ? (
          <video
            src={`${API_URL}${banner.creativeUrl}`}
            muted
            loop
            autoPlay
            playsInline
            className="h-full w-full object-cover"
          />
        ) : (
          <img
            src={`${API_URL}${banner.creativeUrl}`}
            alt=""
            className="h-full w-full object-cover"
          />
        )
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/30 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-1.5 p-4">
        <h3 className="text-lg font-black leading-tight tracking-tight text-white drop-shadow">
          {banner.title}
        </h3>
        {banner.subtitle && (
          <p className="line-clamp-1 text-xs text-zinc-200/90">{banner.subtitle}</p>
        )}
        {banner.ctaLabel && (
          <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white px-3.5 py-1.5 text-xs font-bold text-zinc-950">
            {banner.ctaLabel} <span aria-hidden>→</span>
          </span>
        )}
      </div>
    </div>
  );

  // A banner with no resolvable destination renders as a card, not a dead link.
  if (!href) return body;

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" aria-label={banner.title}>
        {body}
      </a>
    );
  }
  return (
    <Link to={href} aria-label={banner.title}>
      {body}
    </Link>
  );
}
