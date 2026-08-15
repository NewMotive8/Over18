import { adminDestination, type AdminDestinationKey } from './adminNav';

/**
 * Honest empty state for an admin area that does not exist yet (US-99).
 *
 * US-99 delivers the shell only. Rather than mock a screen and imply working
 * functionality, each route says plainly that it is not built and which ticket
 * delivers it. No fake data, no fake controls.
 */
export default function AdminPlaceholder({ destination }: { destination: AdminDestinationKey }) {
  const dest = adminDestination(destination);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold text-white">{dest.label}</h1>
      <p className="mt-1 text-sm text-zinc-400">{dest.description}</p>

      <div className="mt-8 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-10 text-center">
        <p className="text-sm font-medium text-zinc-300">Not built yet</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">
          This area is part of the admin structure but has no functionality in this release.
        </p>
        <p className="mt-4 text-xs uppercase tracking-wide text-zinc-600">Delivered by</p>
        <p className="mt-1 text-sm text-zinc-400">{dest.owner}</p>
      </div>
    </div>
  );
}
