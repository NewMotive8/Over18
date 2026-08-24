/**
 * Which asset KINDS each surface is allowed to see.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * Every public query used to say `kind != 'reference'`. That phrasing answers
 * "is this an identity portrait?" when the question the surface actually needs
 * answered is "is this something the public may see?". The two were the same
 * question only for as long as there were exactly two kinds. Adding `chat` made
 * them different, and a negative test written against a two-value enum silently
 * admits every value added after it — so the day `chat` existed, six surfaces
 * would have started showing private chat media without one line of them
 * changing.
 *
 * So the lists here are POSITIVE ALLOW-LISTS. A kind added in future is
 * excluded from every surface by default and has to be admitted deliberately,
 * which is the safe direction for a mistake to fall.
 *
 * ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────────
 *
 * `public-media-service` already imports from `app-merchandising-service`, so
 * putting these next to `publiclyReachableCondition` and importing them back
 * would close an import cycle. This module imports nothing.
 */

/** The private pool a character may send from inside a conversation. */
export const CHAT_ASSET_KIND = 'chat' as const;

/**
 * Kinds that may EVER be publicly reachable.
 *
 * `reference` is here because a character's canonical portrait is legitimately
 * public — it is her profile picture. `generated` is her content. `chat` is
 * absent, and that absence is the whole boundary: chat media is authorised
 * per-message per-user by the conversation route, and must never become
 * reachable by id, by keyword, by category, or by Hero assignment.
 */
export const PUBLICLY_REACHABLE_KINDS = ['reference', 'generated'] as const;

/**
 * Kinds that count as CONTENT — the character's posts and clips.
 *
 * Narrower than the list above: an identity reference is public but it is not
 * content, which is why Search, Posts, Play with Me, Merchandise and the Hero
 * picker all excluded it long before `chat` existed. Chat media is neither
 * public nor content, so it fails this list twice over.
 */
export const PUBLIC_CONTENT_KINDS = ['generated'] as const;
