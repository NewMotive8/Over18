import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

/**
 * A modal confirmation with real dialog behaviour.
 *
 * Extracted to admin/ so every CMS workspace shares ONE implementation. It was
 * written twice before US-102.3 needed a third; three bespoke dialogs would be
 * three chances for the focus handling to drift.
 *
 * The delete confirmation it replaced was an inline panel that merely CLAIMED to
 * be an alertdialog: it announced itself to a screen reader as a dialog, then
 * left the reader wherever they were, with no way to dismiss it. Either behave
 * like a dialog or do not claim to be one — this behaves like one.
 *
 *   * focus moves to the safe action (cancel) when it opens;
 *   * Tab and Shift+Tab cycle between the two actions and cannot escape;
 *   * Escape dismisses, as does clicking the backdrop;
 *   * focus returns to whatever opened it, so a keyboard operator lands back on
 *     the Delete button of the row they were on.
 *
 * `busy` disables both actions during the request rather than closing early, so
 * the dialog cannot be dismissed into an indeterminate state.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
  tone = 'default',
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  tone?: 'default' | 'danger';
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      // Back to the control that opened it — never to the top of the document.
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [cancelRef.current, confirmRef.current].filter(
      (element): element is HTMLButtonElement => element !== null,
    );
    if (focusable.length < 2) return;
    const [first, last] = [focusable[0]!, focusable[focusable.length - 1]!];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
      >
        <h2 id="confirm-dialog-title" className="text-base font-medium text-neutral-100">
          {title}
        </h2>
        <p
          id="confirm-dialog-body"
          className="mt-2 text-sm leading-relaxed text-neutral-400"
        >
          {body}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${
              tone === 'danger'
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'bg-neutral-100 text-neutral-900 hover:bg-white'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
