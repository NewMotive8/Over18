interface PagePlaceholderProps {
  title: string;
  subtitle?: string;
}

/** Simple placeholder used by all routes until real screens are built. */
export default function PagePlaceholder({ title, subtitle }: PagePlaceholderProps) {
  return (
    <section className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <h2 className="text-2xl font-semibold">{title}</h2>
      {subtitle && <p className="max-w-xs text-sm text-zinc-400">{subtitle}</p>}
      <p className="mt-4 rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-500">
        Placeholder — coming in a later story
      </p>
    </section>
  );
}
