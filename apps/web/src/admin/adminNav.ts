/**
 * Admin navigation model (US-99) — platform-independent.
 *
 * Mirrors the existing `components/nav/destinations.ts` pattern: the set of
 * destinations and the "which one is active for this path" rule are pure data
 * plus a pure function, so both are trivially testable and no routing rule
 * hides inside a component.
 *
 * `status` is deliberately part of the model. US-99 builds the shell only, so
 * the navigation must be honest about which areas do not exist yet rather than
 * presenting dead links as working features.
 */

export type AdminDestinationKey =
  | 'review'
  | 'library'
  | 'characters'
  | 'publishing'
  | 'generation';

export type AdminDestinationStatus = 'available' | 'not-implemented';

export interface AdminDestination {
  key: AdminDestinationKey;
  label: string;
  path: string;
  matchPrefixes: string[];
  description: string;
  status: AdminDestinationStatus;
  /** The ticket that will deliver this area. Shown in the placeholder state. */
  owner: string;
}

/**
 * Epic 11 content-operations areas, in the order the operator works:
 * review what was produced, manage the library, manage the characters behind
 * it, then categorise and publish. Generation sits last because it is a
 * capability inside the admin, not a separate product.
 */
export const ADMIN_DESTINATIONS: readonly AdminDestination[] = [
  {
    key: 'review',
    label: 'Review',
    path: '/admin/content/review',
    matchPrefixes: ['/admin/content/review'],
    description: 'Approve or reject newly generated content',
    status: 'available',
    owner: 'US-106 — Generated Content Review & Approval',
  },
  {
    key: 'library',
    label: 'Content Library',
    path: '/admin/content/library',
    matchPrefixes: ['/admin/content/library', '/admin/content'],
    description: 'Browse and manage all media',
    status: 'available',
    owner: 'US-100 — Content Library & Media Management',
  },
  {
    key: 'characters',
    label: 'Characters',
    path: '/admin/characters',
    matchPrefixes: ['/admin/characters'],
    description: 'Characters, visual identity and Primary references',
    status: 'available',
    owner: 'US-101 — Visual Identity & Primary Reference Management',
  },
  {
    key: 'publishing',
    label: 'Categories & Publishing',
    path: '/admin/publishing',
    matchPrefixes: ['/admin/publishing'],
    description: 'Assign categories and publish approved content',
    status: 'not-implemented',
    owner: 'US-102 — Content Categories & Publishing',
  },
  {
    key: 'generation',
    label: 'Generation',
    path: '/admin/generation',
    matchPrefixes: ['/admin/generation'],
    description: 'Create new content (deferred)',
    status: 'not-implemented',
    owner: 'US-103 / US-104 — deferred pending the production generation flow',
  },
];

/**
 * Which destination should appear active for a path. Longest matching prefix
 * wins, so `/admin/content/review` selects Review rather than Content Library.
 * Returns null on the admin home, which is not itself a destination.
 */
export function activeAdminDestination(pathname: string): AdminDestinationKey | null {
  let best: { key: AdminDestinationKey; length: number } | null = null;
  for (const dest of ADMIN_DESTINATIONS) {
    for (const prefix of dest.matchPrefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.length) best = { key: dest.key, length: prefix.length };
      }
    }
  }
  return best?.key ?? null;
}

export function adminDestination(key: AdminDestinationKey): AdminDestination {
  return ADMIN_DESTINATIONS.find((d) => d.key === key)!;
}
