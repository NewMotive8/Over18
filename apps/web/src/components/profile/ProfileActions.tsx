import { CrownIcon, MessageIcon, PhoneIcon } from '../icons';

/**
 * Primary profile action row (US-29 / brief §2).
 *
 * Up to two large CTA pills — Premium and Chat — plus the compact Call action.
 *
 * PREMIUM ONLY WHEN IT MEANS SOMETHING. `onUpgrade` is passed only for a
 * visitor who can actually upgrade (a signed-in Free customer, or a signed-out
 * visitor who is sent to sign in first). A Premium member gets no button, and
 * Chat takes the row.
 */
export default function ProfileActions({
  onUpgrade,
  onChat,
  onCall,
  chatting = false,
}: {
  onUpgrade?: () => void;
  onChat: () => void;
  onCall: () => void;
  chatting?: boolean;
}) {
  // Chat and Call share the row 4:3 -- Chat a third narrower than when it filled
  // the row, Call a real button. With Premium in the row as well there is no room for the
  // "Call me" label on a phone, so Call keeps its colour and shows the icon.
  const callLabel = !onUpgrade;
  return (
    <div className="flex items-center gap-2">
      {onUpgrade && (
      <button
        type="button"
        onClick={onUpgrade}
        className="flex flex-[4] items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 py-3 text-sm font-bold text-amber-950 shadow-lg shadow-orange-950/30 transition-transform active:scale-95"
      >
        <CrownIcon className="h-4 w-4" /> Premium
      </button>
      )}
      <button
        type="button"
        onClick={onChat}
        disabled={chatting}
        className="flex flex-[4] items-center justify-center gap-1.5 rounded-2xl bg-rose-600 py-3 text-sm font-bold text-white shadow-lg shadow-rose-950/40 transition-transform active:scale-95 disabled:opacity-60"
      >
        <MessageIcon className="h-4 w-4" /> {chatting ? 'Starting…' : 'Chat'}
      </button>
      <button
        type="button"
        onClick={onCall}
        aria-label="Call"
        data-testid="profile-call"
        className="flex min-h-11 flex-[3] items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-green-600 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-950/40 transition-transform active:scale-95"
      >
        <PhoneIcon className="h-4 w-4" />
        {callLabel && <span aria-hidden>Call me</span>}
      </button>
    </div>
  );
}
