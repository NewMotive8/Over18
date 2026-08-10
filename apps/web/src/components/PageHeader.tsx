/**
 * Consistent page heading (US-18) — shared vertical rhythm across shell screens.
 */
export default function PageHeader({
  title,
  subtitle,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}) {
  return (
    <header className="flex flex-col gap-0.5">
      {eyebrow && (
        <span className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">
          {eyebrow}
        </span>
      )}
      <h2 className="text-xl font-semibold tracking-tight text-white">{title}</h2>
      {subtitle && <p className="text-sm text-zinc-400">{subtitle}</p>}
    </header>
  );
}
