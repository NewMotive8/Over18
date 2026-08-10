/**
 * Minimal inline SVG icons (US-18).
 *
 * The repo does not use lucide-react/shadcn/Radix (plain Tailwind only), so —
 * to avoid introducing a UI dependency — the shell uses a few tiny stroke icons
 * in the existing visual language. Decorative by default (aria-hidden).
 */
import type { SVGProps } from 'react';

const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function DiscoverIcon(props: SVGProps<SVGSVGElement>) {
  // compass
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="16.5 7.5 13.5 13.5 7.5 16.5 10.5 10.5" />
    </svg>
  );
}

export function GoSteadyIcon(props: SVGProps<SVGSVGElement>) {
  // heart
  return (
    <svg {...base} {...props}>
      <path d="M12 20s-7-4.35-9.5-8.5C1 8.5 2.5 5.5 5.5 5.5c1.8 0 3 1 2.5 1 .5 0 1.7-1 2.5-1 3 0 4.5 3 3 6C19 15.65 12 20 12 20Z" />
    </svg>
  );
}

export function ProfileIcon(props: SVGProps<SVGSVGElement>) {
  // user
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" />
    </svg>
  );
}

export function SparkleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  );
}

export function PassIcon(props: SVGProps<SVGSVGElement>) {
  // X — pass / skip
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function LikeIcon(props: SVGProps<SVGSVGElement>) {
  // filled heart — interested / like
  return (
    <svg {...base} fill="currentColor" stroke="none" {...props}>
      <path d="M12 20.3S3.5 15 3.5 8.9A4.4 4.4 0 0 1 12 6.9a4.4 4.4 0 0 1 8.5 2c0 6.1-8.5 11.4-8.5 11.4Z" />
    </svg>
  );
}

export function OpenProfileIcon(props: SVGProps<SVGSVGElement>) {
  // chevron up — open / expand the profile
  return (
    <svg {...base} {...props}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function FilterIcon(props: SVGProps<SVGSVGElement>) {
  // funnel — advanced filters
  return (
    <svg {...base} {...props}>
      <path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" />
    </svg>
  );
}

export function MessageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  );
}
