import { displayAge } from '../../lib/lobbyContent';

/**
 * Her name and her age, on a card.
 *
 * -- WHY THIS IS ONE COMPONENT AND NOT A CONVENTION --------------------------
 *
 * Five surfaces rendered this pairing and they had drifted into four different
 * answers: Play with me showed "Donna 32", the results grid showed it at a
 * different weight, the New/Top rated/Popular rails showed no age at all, and
 * two dead components still derived one from the apparent-age band. Each was
 * correct in isolation. Together they meant the same character read differently
 * depending on which rail she appeared in, and that a sixth surface would get it
 * wrong again.
 *
 * -- THE CONFIRMED-ONLY RULE LIVES HERE NOW ---------------------------------
 *
 * It takes the RAW value and resolves it itself, so no caller can hand it a
 * number from somewhere else. `displayAge` accepts only an operator-confirmed
 * adult age: never the apparent-age band, which is the bare string 'adult' for
 * almost the whole roster and used to render as 26 for everyone, and never the
 * persona's guess, which a vision model wrote from one photograph.
 *
 * A null age renders the name alone -- not a placeholder, not a dash. "No age"
 * is a real state, and it is what every surface shows until somebody confirms
 * one in Admin.
 *
 * -- SIZE IS A PROP; THE RELATIONSHIP IS NOT --------------------------------
 *
 * A 160px rail tile and a full-width grid tile legitimately use different text
 * sizes, so `size` picks between them. What does NOT vary is everything that
 * made the surfaces look inconsistent: the separator, the baseline alignment,
 * the gap, the age being lighter and smaller than the name, and the name being
 * the only part that truncates.
 */

export type CardNameAgeSize = 'sm' | 'base';

const NAME_CLASS: Record<CardNameAgeSize, string> = {
  sm: 'text-sm font-bold text-white',
  base: 'text-base font-bold text-white drop-shadow',
};

const AGE_CLASS: Record<CardNameAgeSize, string> = {
  sm: 'text-xs text-zinc-300',
  base: 'text-sm font-medium text-zinc-200',
};

export interface CardNameAgeProps {
  name: string;
  /** Her confirmed age, raw. Resolved here; anything unusable renders nothing. */
  age: number | null | undefined;
  size?: CardNameAgeSize;
  /** Extra classes for the row, for a card that positions it itself. */
  className?: string;
}

export default function CardNameAge({ name, age, size = 'sm', className }: CardNameAgeProps) {
  const resolved = displayAge(age);

  return (
    <div className={`flex min-w-0 items-baseline gap-1.5${className ? ` ${className}` : ''}`}>
      <span className={`truncate ${NAME_CLASS[size]}`}>{name}</span>
      {resolved !== null && (
        <>
          {/*
            Decoration only. The link's accessible name already reads
            "Open Donna, 32" via `cardAriaLabel`, so a screen reader announcing
            a middot here would be noise between the two halves.
          */}
          <span aria-hidden="true" className={`shrink-0 ${AGE_CLASS[size]}`}>
            ·
          </span>
          <span className={`shrink-0 ${AGE_CLASS[size]}`}>{resolved}</span>
        </>
      )}
    </div>
  );
}

/**
 * The accessible name for a card that links to a character.
 *
 * Here rather than written out at each call site for the same reason the
 * component exists: the surfaces had drifted, and one of them announced no age
 * while showing one. Resolves through the same rule, so the label and the
 * visible text can never disagree.
 */
export function cardAriaLabel(name: string, age: number | null | undefined): string {
  const resolved = displayAge(age);
  return resolved === null ? `Open ${name}` : `Open ${name}, ${resolved}`;
}
