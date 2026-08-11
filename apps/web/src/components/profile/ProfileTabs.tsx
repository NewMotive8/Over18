export type ProfileTab = 'about' | 'posts';

/**
 * About / Posts tab switcher (US-29 / brief §2). Presentational + controlled.
 */
export default function ProfileTabs({
  active,
  onChange,
  postsCount,
}: {
  active: ProfileTab;
  onChange: (tab: ProfileTab) => void;
  postsCount?: number;
}) {
  const tab = (key: ProfileTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === key}
      onClick={() => onChange(key)}
      className={`flex-1 rounded-full py-2 text-sm font-semibold transition-colors ${
        active === key ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Profile sections" className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1">
      {tab('about', 'About')}
      {tab('posts', postsCount ? `Posts · ${postsCount}` : 'Posts')}
    </div>
  );
}
