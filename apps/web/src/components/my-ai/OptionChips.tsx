import type { MyAiOption } from '@over18/shared';

/**
 * Text choices as chips — used where a photograph would add nothing.
 *
 * "Bratty", "Submissive" and "Best friend" describe BEHAVIOUR. A picture of a
 * woman cannot show any of them, so a tile grid here would be decoration that
 * slows the step down and implies a precision the choice does not have. Her
 * look is photographed; her character is written.
 *
 * Also the honest home for the attributes still waiting on art — the two
 * ethnicity-independent steps and anything the Anime path adds later.
 */
export interface OptionChipsProps {
  label: string;
  name: string;
  options: readonly MyAiOption[];
  /** A string for single choice, an array for multiple. */
  value: string | readonly string[] | null;
  onChange: (next: string) => void;
  /** When set, the field is multi-select and capped at this many. */
  max?: number;
  hint?: string;
}

export default function OptionChips({
  label,
  name,
  options,
  value,
  onChange,
  max,
  hint,
}: OptionChipsProps) {
  const multi = typeof max === 'number';
  const chosen: readonly string[] = Array.isArray(value) ? value : value ? [value as string] : [];
  const full = multi && chosen.length >= max;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-100">{label}</h2>
        {multi ? (
          <span className="text-xs text-zinc-500">
            {chosen.length}/{max}
          </span>
        ) : (
          hint && <span className="text-xs text-zinc-500">{hint}</span>
        )}
      </div>

      <div
        role={multi ? 'group' : 'radiogroup'}
        aria-label={label}
        data-group={name}
        className="flex flex-wrap gap-2"
      >
        {options.map((option) => {
          const selected = chosen.includes(option.id);
          /*
           * At the cap, the unchosen chips are disabled rather than hidden or
           * silently ignored: the user can see what they would be trading away
           * and that deselecting one frees a slot. A chip that looks tappable
           * and does nothing is the version of this that feels broken.
           */
          const disabled = Boolean(full && !selected);
          return (
            <button
              key={option.id}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={selected}
              disabled={disabled}
              data-id={option.id}
              onClick={() => onChange(option.id)}
              className={`rounded-full border px-3.5 py-2 text-sm font-medium transition ${
                selected
                  ? 'border-rose-500 bg-rose-500/15 text-rose-200'
                  : disabled
                    ? 'cursor-not-allowed border-zinc-800/60 text-zinc-600'
                    : 'border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
