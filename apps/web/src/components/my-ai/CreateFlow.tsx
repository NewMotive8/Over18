import { useEffect, useMemo, useState } from 'react';
import {
  MY_AI_BREASTS,
  MY_AI_BUTTS,
  MY_AI_DEFAULT_AGE,
  MY_AI_ETHNICITIES,
  MY_AI_EYE_COLOURS,
  MY_AI_FIGURES,
  MY_AI_HAIR_COLOURS,
  MY_AI_HAIR_STYLES,
  MY_AI_INTERESTS,
  MY_AI_JOBS,
  MY_AI_MAX_AGE,
  MY_AI_MAX_INTERESTS,
  MY_AI_MIN_AGE,
  MY_AI_NAME_MAX_LENGTH,
  MY_AI_PERSONALITIES,
  MY_AI_RELATIONSHIPS,
  MY_AI_VOICES,
  myAiDraftProblems,
  myAiEthnicityTileUrl,
  myAiTileUrl,
  type MyAiDraft,
  type MyAiEthnicity,
  type MyAiPhotoField,
} from '@over18/shared';
import TileRow from './TileRow';
import OptionChips from './OptionChips';

/**
 * "My AI" — the five-step flow a user builds their own companion in.
 *
 * ── THE ETHNICITY RULE, WHICH IS THE WHOLE DESIGN ───────────────────────────
 *
 * Her background is chosen at step 2 and EVERY tile after it is rendered in
 * that ethnicity: a user building a Latina companion picks from Latina hair,
 * Latina eyes and a Latina body, never a generic stand-in and never a different
 * woman's body than the one they are assembling.
 *
 * It holds by construction rather than by discipline. Steps 3 and 4 do not
 * store image URLs; they call `myAiTileUrl(field, option, draft.ethnicity)` at
 * render time, so going back and switching ethnicity re-renders the entire
 * flow with no cache to invalidate and no second code path that could keep
 * serving the old set. The choices themselves survive the switch, because a
 * choice is a value and the photograph is only a view of it.
 *
 * ── WHY FIVE STEPS AND NOT FIFTEEN ──────────────────────────────────────────
 *
 * One attribute per screen (what the reference flows do) came to fifteen
 * screens. Grouping them by what the user is actually deciding — her
 * background, her look, her shape, her vibe — comes to five, and the grouping
 * is only possible in this order because every tile after step 2 depends on it.
 *
 * ── WHY THE LAST FIVE FIELDS ARE ON THE CONFIRM SCREEN ──────────────────────
 *
 * Name, age, voice, job and interests are 70-odd further options. Arriving as a
 * sixth step they are a wall of text at exactly the moment the user has
 * finished the enjoyable part, and walls are where people leave. Pre-filled on
 * the confirm screen instead, a user who does not care taps Create and a user
 * who does taps the one line they care about. Nothing is removed; the default
 * is just already filled in.
 */

/** Pre-filled so the confirm screen is never an empty form. */
const SUGGESTED_NAMES = [
  'Lisa', 'Maya', 'Elena', 'Sofia', 'Nora', 'Ivy', 'Chloe', 'Aria',
  'Luna', 'Zara', 'Mia', 'Leila', 'Naomi', 'Jade', 'Yuna', 'Camila',
];

const pickName = () => SUGGESTED_NAMES[Math.floor(Math.random() * SUGGESTED_NAMES.length)];

type Draft = Omit<MyAiDraft, 'ethnicity'> & { ethnicity: MyAiEthnicity | '' };

const STEP_TITLES = [
  { title: 'Realistic or anime', sub: 'How she should look.' },
  { title: 'Her background', sub: 'Everything after this is shown her way.' },
  { title: 'Her look', sub: 'Hair and eyes.' },
  { title: 'Her shape', sub: "She's yours to design." },
  { title: 'Her vibe', sub: 'How she behaves when you talk.' },
  { title: 'Meet her', sub: 'Change anything, or just create her.' },
];

/** Which draft fields each step requires before Next is allowed. */
const STEP_FIELDS: readonly (readonly (keyof Draft)[])[] = [
  [],
  ['ethnicity'],
  ['hairColour', 'hairStyle', 'eyeColour'],
  ['figure', 'breasts', 'butt'],
  ['personality', 'relationship'],
  [],
];

const CONFIRM_STEP = STEP_TITLES.length - 1;

export interface CreateFlowProps {
  onSubmit: (draft: MyAiDraft) => Promise<void>;
}

export default function CreateFlow({ onSubmit }: CreateFlowProps) {
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(() => ({
    ethnicity: '',
    hairColour: '',
    hairStyle: '',
    eyeColour: '',
    figure: '',
    breasts: '',
    butt: '',
    personality: '',
    relationship: '',
    age: MY_AI_DEFAULT_AGE,
    name: pickName(),
    voice: MY_AI_VOICES[0].id,
    job: 'model',
    interests: [],
  }));

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleInterest = (id: string) =>
    setDraft((d) => ({
      ...d,
      interests: d.interests.includes(id)
        ? d.interests.filter((i) => i !== id)
        : d.interests.length < MY_AI_MAX_INTERESTS
          ? [...d.interests, id]
          : d.interests,
    }));

  const ethnicity = draft.ethnicity;

  /**
   * Resolve a tile in the CHOSEN ethnicity. Steps 3 and 4 are unreachable
   * before step 2 is answered, so the empty case cannot be hit in the flow —
   * it returns null rather than guessing at a default set, because a tile from
   * the wrong ethnicity is worse than no tile.
   */
  const tile = (field: MyAiPhotoField) => (optionId: string) =>
    ethnicity ? myAiTileUrl(field, optionId, ethnicity) : null;

  /**
   * Warm the next two steps' photographs the moment an ethnicity is picked.
   *
   * 31 tiles at roughly 30 KB each. Fetching them while the user is still
   * reading step 2 turns steps 3 and 4 from "tiles fade in as you scroll" into
   * "already there", for well under a megabyte and no blocking work. The
   * browser's own cache makes this idempotent, and dropping the references
   * lets it evict them normally.
   */
  useEffect(() => {
    if (!ethnicity) return;
    const fields: [MyAiPhotoField, readonly { id: string }[]][] = [
      ['hairColour', MY_AI_HAIR_COLOURS],
      ['hairStyle', MY_AI_HAIR_STYLES],
      ['eyeColour', MY_AI_EYE_COLOURS],
      ['figure', MY_AI_FIGURES],
      ['breasts', MY_AI_BREASTS],
      ['butt', MY_AI_BUTTS],
    ];
    for (const [field, options] of fields) {
      for (const option of options) {
        const img = new Image();
        img.src = myAiTileUrl(field, option.id, ethnicity);
      }
    }
  }, [ethnicity]);

  /**
   * Every step starts at the top.
   *
   * Without this, tapping Continue from the bottom of a long step leaves the
   * page exactly where it was and the next step opens half-way down — its
   * heading already scrolled off, so the user arrives at a row of photographs
   * with no idea what they are being asked. Caught in the browser, not in a
   * test: the step state changes but the route does not, so the shell's own
   * scroll restoration never fires.
   *
   * THE DOCUMENT SCROLLS, NOT `<main>` — see AppShell, which measured it.
   */
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  const problems = useMemo(() => myAiDraftProblems(draft as Partial<MyAiDraft>), [draft]);
  const stepComplete = STEP_FIELDS[step].every((f) => !problems.includes(f as string));

  const create = async () => {
    if (problems.length > 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(draft as MyAiDraft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  const labelOf = (options: readonly { id: string; label: string }[], id: string) =>
    options.find((o) => o.id === id)?.label ?? '—';

  return (
    <div className="flex flex-col gap-5 pb-2">
      {/* ---------------------------------------------------------------- *
       * Progress. Five segments, because the confirm screen is a review of
       * work already done rather than a sixth thing to fill in.
       * ---------------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {step === CONFIRM_STEP ? 'Review' : `Step ${step + 1} of 5`}
          </span>
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Back
            </button>
          )}
        </div>
        <div className="flex gap-1" aria-hidden>
          {STEP_TITLES.slice(0, CONFIRM_STEP).map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-rose-500' : 'bg-zinc-800'}`}
            />
          ))}
        </div>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-white">{STEP_TITLES[step].title}</h1>
        <p className="text-sm text-zinc-400">{STEP_TITLES[step].sub}</p>
      </header>

      {/* ---------------------------------------------------------------- *
       * Step 1 — realistic or anime
       * ---------------------------------------------------------------- */}
      {step === 0 && (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            data-style="realistic"
            onClick={() => setStep(1)}
            className="flex flex-col items-start gap-1 rounded-xl border border-rose-500 bg-rose-500/10 p-4 text-left ring-1 ring-rose-500"
          >
            <span className="text-base font-semibold text-white">Realistic</span>
            <span className="text-xs text-zinc-400">Photo-real</span>
          </button>
          {/*
           * Anime is visible and disabled rather than absent. Leaving it out
           * would make the five-step flow look like the whole product; showing
           * it greyed says the choice exists and is not ready, which is the
           * truth and sets up the second path without pretending.
           */}
          <div
            aria-disabled
            className="flex cursor-not-allowed flex-col items-start gap-1 rounded-xl border border-zinc-800 p-4 text-left opacity-55"
          >
            <span className="text-base font-semibold text-zinc-300">Anime</span>
            <span className="text-xs text-zinc-500">Coming soon</span>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Step 2 — her background. The choice every later tile depends on.
       * ---------------------------------------------------------------- */}
      {step === 1 && (
        <TileRow
          label="Ethnicity"
          name="ethnicity"
          layout="grid"
          options={MY_AI_ETHNICITIES}
          value={draft.ethnicity || null}
          onChange={(id) => set('ethnicity', id as MyAiEthnicity)}
          tileUrl={(id) => myAiEthnicityTileUrl(id as MyAiEthnicity)}
        />
      )}

      {/* ---------------------------------------------------------------- *
       * Step 3 — her look
       * ---------------------------------------------------------------- */}
      {step === 2 && (
        <div className="flex flex-col gap-6">
          <TileRow label="Hair colour" name="hairColour" options={MY_AI_HAIR_COLOURS} value={draft.hairColour || null} onChange={(v) => set('hairColour', v)} tileUrl={tile('hairColour')} />
          <TileRow label="Hair style" name="hairStyle" options={MY_AI_HAIR_STYLES} value={draft.hairStyle || null} onChange={(v) => set('hairStyle', v)} tileUrl={tile('hairStyle')} />
          <TileRow label="Eyes" name="eyeColour" options={MY_AI_EYE_COLOURS} value={draft.eyeColour || null} onChange={(v) => set('eyeColour', v)} tileUrl={tile('eyeColour')} />
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Step 4 — her shape
       * ---------------------------------------------------------------- */}
      {step === 3 && (
        <div className="flex flex-col gap-6">
          <TileRow label="Body type" name="figure" options={MY_AI_FIGURES} value={draft.figure || null} onChange={(v) => set('figure', v)} tileUrl={tile('figure')} />
          <TileRow label="Breasts" name="breasts" options={MY_AI_BREASTS} value={draft.breasts || null} onChange={(v) => set('breasts', v)} tileUrl={tile('breasts')} />
          <TileRow label="Ass" name="butt" options={MY_AI_BUTTS} value={draft.butt || null} onChange={(v) => set('butt', v)} tileUrl={tile('butt')} />
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Step 5 — her vibe
       * ---------------------------------------------------------------- */}
      {step === 4 && (
        <div className="flex flex-col gap-6">
          <OptionChips label="Personality" name="personality" options={MY_AI_PERSONALITIES} value={draft.personality || null} onChange={(v) => set('personality', v)} />
          <OptionChips label="She is your…" name="relationship" options={MY_AI_RELATIONSHIPS} value={draft.relationship || null} onChange={(v) => set('relationship', v)} />
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Confirm — everything pre-filled, each line tappable to change
       * ---------------------------------------------------------------- */}
      {step === CONFIRM_STEP && (
        <div className="flex flex-col gap-4">
          <dl className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
            <SummaryRow
              term="Name"
              value={draft.name.trim() || 'Give her a name'}
              open={editing === 'name'}
              onToggle={() => setEditing(editing === 'name' ? null : 'name')}
            >
              <input
                type="text"
                value={draft.name}
                maxLength={MY_AI_NAME_MAX_LENGTH}
                onChange={(e) => set('name', e.target.value)}
                aria-label="Her name"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-rose-500"
              />
            </SummaryRow>

            <SummaryRow
              term="Age"
              value={`${draft.age}`}
              open={editing === 'age'}
              onToggle={() => setEditing(editing === 'age' ? null : 'age')}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={MY_AI_MIN_AGE}
                  max={MY_AI_MAX_AGE}
                  value={draft.age}
                  onChange={(e) => set('age', Number(e.target.value))}
                  aria-label="Her age"
                  className="h-1 w-full accent-rose-500"
                />
                <span className="w-8 text-right text-sm font-semibold text-white">{draft.age}</span>
              </div>
              {/*
               * Stated, not hidden. The platform's own floor is 18, but the
               * provider that renders her enforces 21 and refuses anything
               * below it — so the slider stops at 21 and says why, rather than
               * failing at the last step for a reason the user cannot see.
               */}
              <p className="mt-2 text-xs text-zinc-500">All companions are adults, 21 and over.</p>
            </SummaryRow>

            <SummaryRow
              term="Voice"
              value={labelOf(MY_AI_VOICES, draft.voice)}
              open={editing === 'voice'}
              onToggle={() => setEditing(editing === 'voice' ? null : 'voice')}
            >
              <OptionChips label="Voice" name="voice" options={MY_AI_VOICES} value={draft.voice} onChange={(v) => set('voice', v)} />
            </SummaryRow>

            <SummaryRow
              term="Job"
              value={labelOf(MY_AI_JOBS, draft.job)}
              open={editing === 'job'}
              onToggle={() => setEditing(editing === 'job' ? null : 'job')}
            >
              <OptionChips label="Job" name="job" options={MY_AI_JOBS} value={draft.job} onChange={(v) => set('job', v)} />
            </SummaryRow>

            <SummaryRow
              term="Interests"
              value={
                draft.interests.length
                  ? draft.interests.map((i) => labelOf(MY_AI_INTERESTS, i)).join(', ')
                  : 'None'
              }
              open={editing === 'interests'}
              onToggle={() => setEditing(editing === 'interests' ? null : 'interests')}
            >
              <OptionChips label="Interests" name="interests" options={MY_AI_INTERESTS} value={draft.interests} onChange={toggleInterest} max={MY_AI_MAX_INTERESTS} />
            </SummaryRow>
          </dl>

          <p className="text-xs leading-relaxed text-zinc-500">
            {labelOf(MY_AI_ETHNICITIES, draft.ethnicity)} · {labelOf(MY_AI_HAIR_COLOURS, draft.hairColour)}{' '}
            {labelOf(MY_AI_HAIR_STYLES, draft.hairStyle).toLowerCase()} hair ·{' '}
            {labelOf(MY_AI_EYE_COLOURS, draft.eyeColour).toLowerCase()} eyes ·{' '}
            {labelOf(MY_AI_FIGURES, draft.figure).toLowerCase()} ·{' '}
            {labelOf(MY_AI_PERSONALITIES, draft.personality).toLowerCase()} ·{' '}
            your {labelOf(MY_AI_RELATIONSHIPS, draft.relationship).toLowerCase()}
          </p>

          {error && (
            <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- *
       * Actions. Sticky inside the scroll region so it stacks ABOVE the
       * shell's own bottom navigation rather than fighting it for the edge.
       * ---------------------------------------------------------------- */}
      {step > 0 && (
        <div className="sticky bottom-0 -mx-4 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
          {step < CONFIRM_STEP ? (
            <button
              type="button"
              id="next"
              disabled={!stepComplete}
              onClick={() => setStep((s) => s + 1)}
              className="w-full rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {stepComplete ? 'Continue' : 'Choose to continue'}
            </button>
          ) : (
            <button
              type="button"
              id="create"
              disabled={problems.length > 0 || submitting}
              onClick={create}
              className="w-full rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {submitting ? 'Creating her…' : `Create ${draft.name.trim() || 'her'}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One line of the confirm list: a value, and the editor it opens. */
function SummaryRow({
  term,
  value,
  open,
  onToggle,
  children,
}: {
  term: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-900/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <dt className="shrink-0 text-sm text-zinc-400">{term}</dt>
        <dd className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <span className="truncate">{value}</span>
          <span aria-hidden className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </dd>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
