import { useEffect, useRef, useState } from 'react';
import { MY_AI_VOICES } from '@over18/shared';
import { API_URL } from '../../lib/api';

/**
 * Choosing a voice by hearing it.
 *
 * A list of six names tells you nothing. "Serena" and "Maia" are not
 * descriptions — the only way to know which one she should have is to listen,
 * so picking one plays it. One tap does both, because a separate play button
 * makes hearing the thing an optional extra step, and almost nobody takes an
 * optional extra step.
 *
 * ── WHAT IS ACTUALLY PLAYING ────────────────────────────────────────────────
 *
 * The same sentence in each voice, rendered once and cached on the server.
 * These are not generated per visit and nothing is billed by pressing them.
 * The server maps the name shown here to the voice a real call would use, so
 * this is a preview rather than an impression of one.
 *
 * A voice with no cached sample stays fully selectable and simply does not
 * play — the sample files are per-environment and a missing one is an
 * ordinary state, not a reason to withhold the choice.
 */
export interface VoicePickerProps {
  value: string;
  onChange: (voice: string) => void;
}

export default function VoicePicker({ value, onChange }: VoicePickerProps) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [silent, setSilent] = useState<Set<string>>(() => new Set());
  const audio = useRef<HTMLAudioElement | null>(null);

  /* Leaving the step must not leave a voice talking to an empty room. */
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [],
  );

  const pick = (voice: string) => {
    onChange(voice);

    const el = audio.current ?? (audio.current = new Audio());
    el.pause();
    el.src = `${API_URL}/api/voice-samples/${encodeURIComponent(voice)}`;
    el.onended = () => setPlaying(null);
    el.onerror = () => {
      // No sample in this environment. Remember it so the UI stops implying
      // there is something to hear, and never block the selection.
      setSilent((prev) => new Set(prev).add(voice));
      setPlaying(null);
    };
    setPlaying(voice);
    void el.play().catch(() => setPlaying(null));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-zinc-300">Voice</span>
        <span className="text-xs text-zinc-500">Tap to hear her</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {MY_AI_VOICES.map((voice) => {
          const chosen = value === voice.id;
          const isPlaying = playing === voice.id;
          return (
            <button
              key={voice.id}
              type="button"
              onClick={() => pick(voice.id)}
              aria-pressed={chosen}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                chosen
                  ? 'border-rose-500 bg-rose-500/15 text-rose-200'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-600'
              }`}
            >
              <SpeakerIcon playing={isPlaying} muted={silent.has(voice.id)} />
              {voice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Three states in one glyph: silent, playing, and nothing to play.
 *
 * The animated bars are the only honest "it is speaking right now" indicator
 * available — audio has no visual of its own, and a tap that makes no visible
 * difference reads as a tap that did not register.
 */
function SpeakerIcon({ playing, muted }: { playing: boolean; muted: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 opacity-40" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
        <path d="m16 9 5 6M21 9l-5 6" />
      </svg>
    );
  }
  if (playing) {
    return (
      /* Three bars that jump out of step. Reduced motion keeps the bars and
         drops the jumping, so the state is still visible without movement. */
      <span className="flex h-4 w-4 items-center justify-center gap-[2px]" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            style={{ animationDelay: `${delay}ms` }}
            className="h-2.5 w-[3px] rounded-full bg-current motion-safe:animate-bounce"
          />
        ))}
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}
