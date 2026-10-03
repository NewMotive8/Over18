import { MINIMUM_AGE, type GateStatus } from '../lib/ageGate';

/**
 * The age-entry gate, as a person meets it.
 *
 * ── IT REPLACES THE APPLICATION, IT DOES NOT COVER IT ────────────────────────
 *
 * A modal laid over the page would leave the page mounted underneath: its
 * components would render, their effects would run, and their requests would
 * go out -- so a character's explicit clips would have been fetched, and
 * present in the document, behind a panel that only looked like a barrier. A
 * screen-reader user could have read straight through it.
 *
 * So `AppShell` returns this INSTEAD OF its outlet. Nothing beyond the gate is
 * constructed until the answer is yes, which is the only version of "not
 * rendered" worth claiming.
 *
 * ── A PURE RENDER ────────────────────────────────────────────────────────────
 *
 * State and storage live in `lib/ageGate`; this takes a status and two
 * callbacks. That is what lets it be asserted in a node test environment with
 * no DOM, the way every other component in this repo is tested.
 */

export interface AgeGateProps {
  status: Exclude<GateStatus, 'confirmed'>;
  onConfirm: () => void;
  onDecline: () => void;
  /** Returns a declined visitor to the question, so a mis-tap is not a wall. */
  onBack: () => void;
}

export default function AgeGate({ status, onConfirm, onDecline, onBack }: AgeGateProps) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center bg-zinc-950 px-6 py-10 text-zinc-100">
      {status === 'asking' ? (
        <Asking onConfirm={onConfirm} onDecline={onDecline} />
      ) : (
        <Declined onBack={onBack} />
      )}
    </div>
  );
}

function Asking({ onConfirm, onDecline }: { onConfirm: () => void; onDecline: () => void }) {
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      aria-describedby="age-gate-body"
      className="flex flex-col gap-6 text-center"
    >
      <p className="text-2xl font-semibold tracking-tight text-white">
        Over<span className="text-rose-500">18</span>
      </p>

      {/* The warning, before the buttons and before anything else on the page. */}
      <h1 id="age-gate-title" className="text-xl font-semibold text-white">
        {MINIMUM_AGE}+ only
      </h1>

      <div id="age-gate-body" className="flex flex-col gap-3 text-sm leading-relaxed text-zinc-400">
        <p>
          This site contains sexually explicit material and is intended for adults aged{' '}
          {MINIMUM_AGE} or over.
        </p>
        <p>
          Every character here is fictional and AI-generated. Images, voices and conversations are
          synthetic — no real person is depicted.
        </p>
        <p>
          By entering you confirm that you are at least {MINIMUM_AGE} years old and that adult
          material is legal where you live.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-full bg-rose-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
        >
          I am {MINIMUM_AGE} or over — enter
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="rounded-full border border-zinc-700 px-6 py-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
        >
          I am under {MINIMUM_AGE} — leave
        </button>
      </div>

      {/*
        SAID OUT LOUD, BECAUSE THE ALTERNATIVE IS A FALSE IMPRESSION. A button is
        not age verification and this notice is not decoration: a visitor should
        not infer from a confident-looking gate that anything was checked.
      */}
      <p className="text-xs leading-relaxed text-zinc-600">
        This is a self-declared entry check. Nothing is verified.
      </p>
    </section>
  );
}

/**
 * What someone under 18 is shown.
 *
 * NO CONTENT, AND NOTHING STORED. The application is never constructed, and
 * "declined" is not written to the browser -- see `initialStatus`. The way back
 * is deliberate rather than accidental: one button, clearly labelled, so nobody
 * is trapped by a mis-tap, and nothing about the refusal is treated as final.
 *
 * It does not navigate to some other website. Choosing a destination for
 * somebody would mean inventing one, and an invented link is worse than an
 * honest dead end they can close.
 */
function Declined({ onBack }: { onBack: () => void }) {
  return (
    <section role="alert" aria-labelledby="age-gate-declined-title" className="flex flex-col gap-5 text-center">
      <h1 id="age-gate-declined-title" className="text-xl font-semibold text-white">
        You cannot enter this site
      </h1>
      <p className="text-sm leading-relaxed text-zinc-400">
        This site is for adults aged {MINIMUM_AGE} or over only. Please close this page.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="self-center rounded-full border border-zinc-700 px-5 py-2.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
      >
        Go back
      </button>
    </section>
  );
}
