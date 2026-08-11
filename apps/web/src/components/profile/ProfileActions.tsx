import { CrownIcon, MessageIcon, PhoneIcon } from '../icons';

/**
 * Primary profile action row (US-29 / brief §2).
 *
 * Two large CTA pills — Premium Upgrade and Chat — plus two compact circular
 * actions (Call, Gift). Call and Premium lead into the existing PremiumGate /
 * subscription placeholder; Chat drives the existing conversation flow.
 */
export default function ProfileActions({
  onUpgrade,
  onChat,
  onCall,
  chatting = false,
}: {
  onUpgrade: () => void;
  onChat: () => void;
  onCall: () => void;
  chatting?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onUpgrade}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 py-3 text-sm font-bold text-amber-950 shadow-lg shadow-orange-950/30 transition-transform active:scale-95"
      >
        <CrownIcon className="h-4 w-4" /> Premium
      </button>
      <button
        type="button"
        onClick={onChat}
        disabled={chatting}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-rose-600 py-3 text-sm font-bold text-white shadow-lg shadow-rose-950/40 transition-transform active:scale-95 disabled:opacity-60"
      >
        <MessageIcon className="h-4 w-4" /> {chatting ? 'Starting…' : 'Chat'}
      </button>
      <button
        type="button"
        onClick={onCall}
        aria-label="Call"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-200 transition-colors hover:text-white"
      >
        <PhoneIcon className="h-5 w-5" />
      </button>
    </div>
  );
}
