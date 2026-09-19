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

import type { AdminAccessView, AdminPermission } from '@over18/shared';

export type AdminDestinationKey =
  | 'review'
  | 'library'
  | 'characters'
  | 'settings'
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
    key: 'settings',
    label: 'Settings',
    path: '/admin/settings/content-requirements',
    matchPrefixes: ['/admin/settings'],
    description: 'Configure the content every character needs',
    status: 'available',
    owner: 'US-100 — Configurable content requirements',
  },
  {
    key: 'publishing',
    label: 'Categories & Publishing',
    path: '/admin/publishing',
    matchPrefixes: ['/admin/publishing'],
    description: 'Manage app categories, ordering and publishing',
    status: 'available',
    owner: 'US-102 — App CMS, Categories & Publishing',
  },
  {
    key: 'generation',
    label: 'Generation',
    path: '/admin/generation',
    matchPrefixes: ['/admin/generation'],
    description: 'Prompt files to images, saved to Google Drive',
    status: 'available',
    owner: 'US-103 — prompt generation workspace (prompt files to Google Drive)',
  },
];

/* ------------------------------------------------------------------ *
 * Gated destinations (PRD v1.2 §30, §34)
 *
 * Sections that exist only for some operators, or only once a switch is on.
 * They are a SEPARATE list rather than entries in ADMIN_DESTINATIONS, so the
 * six content-operations areas -- and every screen that lists them, like the
 * admin home -- are untouched until the server says otherwise.
 *
 * VISIBILITY IS A CONVENIENCE, NEVER THE LOCK. Hiding a section only spares an
 * operator a screen they cannot use; every route behind it is enforced by the
 * server regardless of what this list renders.
 * ------------------------------------------------------------------ */

export type GatedAdminDestinationKey = 'economy' | 'wallets' | 'audit';

export interface GatedAdminDestination extends Omit<AdminDestination, 'key'> {
  key: GatedAdminDestinationKey;
  requires: {
    permission: AdminPermission;
    /** A server switch that must be on, e.g. the audit hook. */
    feature?: keyof AdminAccessView['features'];
  };
}

export const GATED_ADMIN_DESTINATIONS: readonly GatedAdminDestination[] = [
  {
    key: 'economy',
    label: 'Economy',
    path: '/admin/economy',
    matchPrefixes: ['/admin/economy'],
    description: 'Plans, packs, costs and the economy preview',
    status: 'available',
    owner: 'P1.4 — Economy Admin UI (PRD v1.2 §31)',
    requires: { permission: 'economy.manage' },
  },
  {
    key: 'wallets',
    label: 'Wallets',
    path: '/admin/wallets',
    matchPrefixes: ['/admin/wallets'],
    description: "A user's wallets and ledger, and support Credit and Debit",
    status: 'available',
    owner: 'P2.4 — User Wallet and Support adjustment UI (PRD v1.2 §34)',
    requires: { permission: 'users.commercial.read' },
  },
  {
    key: 'audit',
    label: 'Audit',
    path: '/admin/audit',
    matchPrefixes: ['/admin/audit'],
    description: 'Who changed what, when, and why',
    status: 'available',
    owner: 'PRD v1.2 §34 — admin roles and audit',
    requires: { permission: 'audit.read', feature: 'auditLog' },
  },
];

export type AnyAdminDestination = AdminDestination | GatedAdminDestination;
export type AnyAdminDestinationKey = AdminDestinationKey | GatedAdminDestinationKey;

/**
 * What the navigation shows for this operator.
 *
 * With no access information -- still loading, or the request failed -- it is
 * exactly the six ungated areas, which is what the admin always showed. A
 * gated section appears only when the server positively reports both its
 * permission and its switch.
 */
export function visibleAdminDestinations(
  access: AdminAccessView | null,
): readonly AnyAdminDestination[] {
  if (!access) return ADMIN_DESTINATIONS;
  const gated = GATED_ADMIN_DESTINATIONS.filter(
    (dest) =>
      access.permissions.includes(dest.requires.permission) &&
      (!dest.requires.feature || access.features[dest.requires.feature]),
  );
  return [...ADMIN_DESTINATIONS, ...gated];
}

/**
 * Which destination should appear active for a path. Longest matching prefix
 * wins, so `/admin/content/review` selects Review rather than Content Library.
 * Returns null on the admin home, which is not itself a destination.
 */
export function activeAdminDestination(pathname: string): AnyAdminDestinationKey | null {
  let best: { key: AnyAdminDestinationKey; length: number } | null = null;
  for (const dest of [...ADMIN_DESTINATIONS, ...GATED_ADMIN_DESTINATIONS]) {
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
