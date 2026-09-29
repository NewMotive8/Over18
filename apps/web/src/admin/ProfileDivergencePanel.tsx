import { compareProfileAndPersona, type CharacterPersona } from '@over18/shared';

/**
 * The two descriptions of one character, side by side, and whether they agree.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * A character is described twice and the two records never update each other.
 * The About tab renders her public profile; Chat compiles her persona into the
 * system prompt and shows a customer none of it. So an operator can regenerate
 * a persona, decline the profile rewrite -- or hand-edit the persona, which
 * offers no rewrite at all -- and leave a character whose page says "marketing
 * coordinator" while she says "Bollywood actress" in chat. Until now nothing in
 * the product mentioned it, on any screen.
 *
 * ── DIAGNOSTIC ONLY ──────────────────────────────────────────────────────────
 *
 * It reads. It never writes, never offers to synchronise the two, and never
 * claims one side is correct: divergence is a legitimate choice for some
 * characters, and the operator is the one who knows which. Both values are shown
 * verbatim precisely so the judgement stays theirs -- the warning is a prompt to
 * look, not a verdict.
 *
 * DERIVED ON EVERY RENDER, from the same data the page already holds, so it
 * cannot go stale. There is no stored status to fall out of date with the
 * record it describes.
 */

interface PublicProfile {
  shortBio: string;
  personality: string;
  interests: string[];
  conversationStyle: string;
}

/** The persona fields worth reading beside the public profile. */
const PERSONA_ROWS = [
  { key: 'occupation', label: 'Occupation' },
  { key: 'ageRange', label: 'Age range' },
  { key: 'lifeStage', label: 'Life stage' },
  { key: 'relationshipToWorkOrSchool', label: 'Relationship to work' },
  { key: 'socialStyle', label: 'Social style' },
  { key: 'humorStyle', label: 'Humor style' },
  { key: 'speechRegister', label: 'Speech register' },
] as const;

const asText = (value: unknown): string | null => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value.trim();
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-xs leading-relaxed ${value ? 'text-zinc-200' : 'text-zinc-600'}`}>
        {value ?? 'Not set'}
      </dd>
    </div>
  );
}

export default function ProfileDivergencePanel({
  character,
  persona,
}: {
  character: PublicProfile;
  persona: CharacterPersona | null;
}) {
  const occupation = asText(persona?.occupation);
  const result = compareProfileAndPersona({
    shortBio: character.shortBio,
    personality: character.personality,
    personaOccupation: occupation,
  });

  /**
   * Three states, three different things to say. `consistent` deliberately
   * reads as "nothing detected" rather than "these agree": a word comparison
   * cannot see through synonyms, so claiming agreement would be a promise this
   * cannot keep.
   */
  const banner = {
    diverged: {
      box: 'border-amber-500/40 bg-amber-500/5',
      title: 'text-amber-200',
      body: 'text-amber-200/80',
      heading: 'Her page and her chat describe different work',
    },
    consistent: {
      box: 'border-zinc-800 bg-zinc-900/40',
      title: 'text-zinc-300',
      body: 'text-zinc-500',
      heading: 'No obvious divergence detected',
    },
    incomplete: {
      box: 'border-zinc-800 bg-zinc-900/40',
      title: 'text-zinc-300',
      body: 'text-zinc-500',
      heading: 'Not enough to compare',
    },
  }[result.status];

  return (
    <section className="mb-10" data-testid="profile-divergence">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Profile vs chat persona
        </h2>
        <span
          data-testid="divergence-status"
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            result.status === 'diverged'
              ? 'bg-amber-400/90 text-amber-950'
              : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {result.status === 'diverged'
            ? 'Differs'
            : result.status === 'consistent'
              ? 'No divergence found'
              : 'Incomplete'}
        </span>
      </div>

      <div className={`mb-4 rounded-lg border px-3 py-2 ${banner.box}`}>
        <p className={`text-sm font-medium ${banner.title}`}>{banner.heading}</p>
        <p className={`mt-1 text-xs leading-relaxed ${banner.body}`}>{result.summary}</p>
        {result.status === 'diverged' && (
          <p className="mt-2 text-xs leading-relaxed text-amber-200/70">
            Neither is changed by this notice, and a difference can be deliberate. To align them,
            edit her bio in Persona above, or generate from her photo and accept the profile it
            proposes.
          </p>
        )}
        {result.status === 'consistent' && (
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            This compares her persona&rsquo;s occupation against her public bio and personality by
            wording only. It cannot recognise synonyms, so this means no contradiction was found
            &mdash; not that the two are guaranteed to agree.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
            Public profile
          </h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            What customers read on her About tab.
          </p>
          <dl className="mt-3 space-y-3">
            <Field label="Short bio" value={asText(character.shortBio)} />
            <Field label="Personality" value={asText(character.personality)} />
            <Field label="Interests" value={asText(character.interests)} />
            <Field label="Conversation style" value={asText(character.conversationStyle)} />
          </dl>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
            Chat persona
          </h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Used to build the chat prompt. Never shown to customers.
          </p>
          {persona ? (
            <dl className="mt-3 space-y-3">
              {PERSONA_ROWS.map((row) => (
                <Field
                  key={row.key}
                  label={row.label}
                  value={asText((persona as Record<string, unknown>)[row.key])}
                />
              ))}
            </dl>
          ) : (
            <p className="mt-3 text-xs text-zinc-600">
              No chat persona yet. Generate one from her photo below.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
