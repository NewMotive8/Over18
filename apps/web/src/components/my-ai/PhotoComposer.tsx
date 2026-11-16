import { useState } from 'react';
import {
  MY_AI_PHOTO_IDEAS,
  MY_AI_PHOTO_PROMPT_MAX,
  MY_AI_PHOTO_STYLES,
  myAiPhotoProblems,
} from '@over18/shared';

/**
 * Asking for another photograph of a companion.
 *
 * ── A BOX, NOT A MENU ───────────────────────────────────────────────────────
 *
 * The point of the feature is that the user decides: an outfit, no outfit, a
 * place, a mood. A fixed list of looks would be a different, smaller feature
 * wearing this one's name. So whatever is typed is what gets sent.
 *
 * The ideas below are STARTING POINTS, not options. A blank box is the
 * hardest thing in an interface to answer, and one tap replaces it with a
 * sentence that can then be edited word by word. Nothing is locked by picking
 * one.
 *
 * ── IT SAYS WHAT IT COSTS, BECAUSE IT COSTS SOMETHING ───────────────────────
 *
 * Each photograph is a real charge at the provider. Credits are not wired up
 * yet, and this does not pretend they are — but the button says "Create
 * photo" rather than something frictionless, and one is made at a time.
 */
export interface PhotoComposerProps {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { prompt: string; style: string }) => void;
}

export default function PhotoComposer({ name, busy, onCancel, onCreate }: PhotoComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string>(MY_AI_PHOTO_STYLES[0].id);
  const ready = myAiPhotoProblems({ prompt, style }).length === 0;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div>
        <h3 className="text-base font-semibold text-white">A new photo of {name}</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Describe what you want to see — what she is wearing, or not, and where she is.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, MY_AI_PHOTO_PROMPT_MAX))}
          rows={3}
          placeholder="In black lingerie, on a bed, warm lamplight"
          aria-label={`What ${name} should be doing in the photo`}
          /* text-base: anything under 16px makes iOS zoom the page in on
             focus and never zoom back out. */
          className="w-full resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-base text-white placeholder-zinc-600 outline-none focus:border-rose-500"
        />
        <div className="flex justify-end text-xs tabular-nums text-zinc-600">
          {prompt.length}/{MY_AI_PHOTO_PROMPT_MAX}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-zinc-400">Or start from one of these</span>
        <div className="flex flex-wrap gap-2">
          {MY_AI_PHOTO_IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              onClick={() => setPrompt(idea)}
              className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
            >
              {idea}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-zinc-400">Look</span>
        <div className="flex gap-2">
          {MY_AI_PHOTO_STYLES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setStyle(option.id)}
              aria-pressed={style === option.id}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                style === option.id
                  ? 'border-rose-500 bg-rose-500/15 text-rose-200'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-600'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-600">
          {style === 'glam'
            ? 'A clean, well-lit photograph.'
            : 'Looks like it was taken on a phone.'}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-xl border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-600"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onCreate({ prompt: prompt.trim(), style })}
          disabled={!ready || busy}
          className="flex-1 rounded-xl bg-rose-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {busy ? 'Starting…' : ready ? 'Create photo' : 'Describe the photo'}
        </button>
      </div>
    </div>
  );
}
