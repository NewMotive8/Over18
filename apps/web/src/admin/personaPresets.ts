/**
 * The persona editor, for someone who is not a prompt writer.
 *
 * TWO FIELDS STOPPED PEOPLE PUBLISHING, and neither said so. "Conversation
 * style" was an empty box with no hint of what belonged in it, and "System
 * prompt" was hidden until the editor was opened -- yet both are required
 * before a character can go live, and the page only said "2 fields empty".
 *
 * - HOW SHE TALKS is now a choice. Each option stores one plain sentence in the
 *   same `conversationStyle` column; "Write my own" keeps the free text for
 *   anyone who wants it, and a character whose stored text is not one of the
 *   options simply reads as "Write my own" -- nothing is rewritten.
 * - THE SYSTEM PROMPT IS FILLED IN FOR THEM. The server still requires the
 *   column to be non-empty, but the chat prompt no longer reads it (see
 *   `prompt-builder.ts`: persona is stated as facts, and the stored prompt is
 *   not rendered). Asking an operator to compose text nothing reads is a gate
 *   with no purpose, so an empty one is saved as a standard line. It stays
 *   editable under Advanced.
 *
 * Nothing here changes what the server requires or stores: same columns, same
 * request.
 */

export interface ConversationStylePreset {
  key: string;
  /** What the operator picks. */
  label: string;
  /** The sentence stored as her conversation style. */
  text: string;
}

export const CONVERSATION_STYLES: readonly ConversationStylePreset[] = [
  { key: 'playful', label: 'Playful & teasing', text: 'Playful and teasing, quick with a joke, light and flirty.' },
  { key: 'warm', label: 'Warm & caring', text: 'Warm and attentive, gentle, asks about your day and really listens.' },
  { key: 'confident', label: 'Confident & direct', text: 'Confident and direct, says what she wants, no hedging.' },
  { key: 'shy', label: 'Shy & sweet', text: 'Soft-spoken and a little shy at first, sweet, opens up slowly.' },
  { key: 'sensual', label: 'Calm & sensual', text: 'Slow, calm and sensual, unhurried, a low and intimate voice.' },
  { key: 'witty', label: 'Witty & dry', text: 'Dry and witty, understated, a raised-eyebrow sense of humour.' },
  { key: 'bubbly', label: 'Bubbly & energetic', text: 'Bubbly and energetic, talks fast, laughs easily.' },
];

export const CUSTOM_STYLE = 'custom';

/** Which option a stored conversation style is: a preset's key, "custom" for her own text, "" for none yet. */
export function styleKeyOf(conversationStyle: string): string {
  const stored = conversationStyle.trim();
  if (stored === '') return '';
  return CONVERSATION_STYLES.find((preset) => preset.text === stored)?.key ?? CUSTOM_STYLE;
}

/** The text an option stores; null for "custom" and "none", which store what is typed. */
export function styleTextOf(key: string): string | null {
  return CONVERSATION_STYLES.find((preset) => preset.key === key)?.text ?? null;
}

/** A stored conversation style as the operator reads it back: the option's name, or her own text. */
export function styleLabelOf(conversationStyle: string): string {
  const key = styleKeyOf(conversationStyle);
  if (key === '') return '';
  return CONVERSATION_STYLES.find((preset) => preset.key === key)?.label ?? conversationStyle.trim();
}

/** The line saved when the system prompt is left empty. */
export function defaultSystemPrompt(displayName: string): string {
  return `You are ${displayName.trim()}.`;
}

/** The system prompt to save: what was typed, or the standard line when nothing was. */
export function systemPromptToSave(typed: string, displayName: string): string {
  return typed.trim() === '' ? defaultSystemPrompt(displayName) : typed;
}

const FIELD_LABEL: Record<string, string> = {
  shortBio: 'Short bio',
  personality: 'Personality',
  conversationStyle: 'How she talks',
};

/**
 * What the operator still has to provide before she can be published, by the
 * name each field has on screen. The system prompt is not listed: it is filled
 * in automatically, so it is never something to go and do.
 */
export function missingToPublish(missingProfileFields: readonly string[]): string[] {
  return missingProfileFields.filter((field) => field !== 'systemPrompt').map((field) => FIELD_LABEL[field] ?? field);
}

/**
 * What the editor still needs before it can be saved, by on-screen name. The
 * server refuses an empty value for any of these, so the form says which one
 * before sending anything.
 */
export function missingInDraft(draft: { displayName: string; shortBio: string; personality: string; conversationStyle: string }): string[] {
  const fields: Array<[keyof typeof draft, string]> = [
    ['displayName', 'Display name'],
    ['shortBio', 'Short bio'],
    ['personality', 'Personality'],
    ['conversationStyle', 'How she talks'],
  ];
  return fields.filter(([key]) => draft[key].trim() === '').map(([, label]) => label);
}

/** Publishing is possible once nothing the operator must provide is missing. */
export function canPublish(character: { missingProfileFields: readonly string[] }): boolean {
  return missingToPublish(character.missingProfileFields).length === 0;
}

/**
 * The request that publishes her. If only the system prompt is empty, the
 * standard line goes with it, so the one press does what it says.
 */
export function publishPatch(character: { displayName: string; missingProfileFields: readonly string[] }): {
  status: 'active';
  systemPrompt?: string;
} {
  return character.missingProfileFields.includes('systemPrompt')
    ? { status: 'active', systemPrompt: defaultSystemPrompt(character.displayName) }
    : { status: 'active' };
}

/** The one next step for an unpublished character, short enough to read at a glance. */
export function publishNextStep(character: { missingProfileFields: readonly string[] }): string {
  const missing = missingToPublish(character.missingProfileFields);
  return missing.length === 0 ? 'Ready — press Publish to make her public.' : `To publish, add: ${missing.join(', ')}.`;
}
