import { describe, expect, it } from 'vitest';
import { orderByRecency, type LibraryAsset } from '../services/content-review-service.js';

/** Pure ordering rule for the library's recency view — no DB needed. */
function asset(id: string, recentAt: string, recencyBasis: 'approved' | 'added'): LibraryAsset {
  return { id, recentAt: new Date(recentAt), recencyBasis } as unknown as LibraryAsset;
}

describe('US-100 recency ordering', () => {
  it('puts the newest recency event first', () => {
    const ordered = orderByRecency([
      asset('a', '2026-08-15T09:00:00Z', 'added'),
      asset('c', '2026-08-15T11:00:00Z', 'approved'),
      asset('b', '2026-08-15T10:00:00Z', 'added'),
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['c', 'b', 'a']);
  });

  it('is deterministic when two events share a timestamp', () => {
    const same = '2026-08-15T09:00:00Z';
    const ordered = orderByRecency([asset('b', same, 'added'), asset('a', same, 'approved')]);
    expect(ordered.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('ranks an approval above an older addition regardless of creation order', () => {
    // Approving old content makes it the most recent EVENT — that is the point.
    const ordered = orderByRecency([
      asset('new-but-unapproved', '2026-08-15T10:00:00Z', 'added'),
      asset('old-but-approved', '2026-08-15T12:00:00Z', 'approved'),
    ]);
    expect(ordered[0].id).toBe('old-but-approved');
    expect(ordered[0].recencyBasis).toBe('approved');
  });

  it('does not mutate its input', () => {
    const input = [asset('a', '2026-08-15T09:00:00Z', 'added'), asset('b', '2026-08-15T10:00:00Z', 'added')];
    orderByRecency(input);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
