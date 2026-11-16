import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MyAiSignInRequired, myAiDraftStash } from './myAiDraft';

/**
 * "Sign in to create her — everything you picked is kept."
 *
 * The sentence is a promise, and the Sign in button beside it is what makes
 * the promise collectable. Both halves are tested here: the draft genuinely
 * survives the route change, and nothing a tampered storage entry contains
 * can come back into the wizard as a choice the flow could not have made.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** A complete draft, exactly as the review step would hold it. */
const PICKED = {
  ethnicity: 'latina',
  hairColour: 'blonde',
  hairStyle: 'wavy',
  eyeColour: 'green',
  figure: 'curvy',
  breasts: 'large',
  butt: 'medium',
  personality: 'flirty',
  relationship: 'girlfriend',
  age: 24,
  name: 'Maya',
  voice: 'Serena',
  job: 'model',
  interests: ['yoga', 'travel'],
};

describe('what the visitor picked survives the trip to Sign in', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('keeps every choice, the name, the age and the step', () => {
    myAiDraftStash.write(PICKED, 5);
    expect(myAiDraftStash.read()).toEqual({ draft: PICKED, step: 5 });
  });

  it('is nothing before anything is kept, and nothing again once she is made', () => {
    expect(myAiDraftStash.read()).toBeNull();
    myAiDraftStash.write(PICKED, 5);
    myAiDraftStash.clear();
    expect(myAiDraftStash.read()).toBeNull();
  });

  it('keeps a half-built draft without inventing the rest', () => {
    // Abandoned at step 2: an ethnicity and the pre-filled fields, nothing else.
    myAiDraftStash.write({ ethnicity: 'asian', name: 'Yuna', age: 24, interests: [] }, 2);
    expect(myAiDraftStash.read()).toEqual({
      draft: { ethnicity: 'asian', name: 'Yuna', age: 24, interests: [] },
      step: 2,
    });
  });

  it('survives a browser that refuses storage entirely', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    expect(() => myAiDraftStash.write(PICKED, 5)).not.toThrow();
    expect(myAiDraftStash.read()).toBeNull();
    expect(() => myAiDraftStash.clear()).not.toThrow();
  });
});

describe('nothing comes back that the flow could not have produced', () => {
  const store = new Map<string, string>();
  const put = (value: unknown) => store.set('over18.myAi.draft', JSON.stringify(value));

  beforeEach(() => {
    store.clear();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('drops an option that is not in the list, and keeps the rest', () => {
    put({ draft: { ...PICKED, breasts: 'enormous', ethnicity: 'martian' }, step: 5 });
    const restored = myAiDraftStash.read()!;
    expect(restored.draft.breasts).toBeUndefined();
    expect(restored.draft.ethnicity).toBeUndefined();
    expect(restored.draft.hairColour).toBe('blonde'); // untouched
  });

  it('drops an age below the provider’s floor of 21, or one that is not a whole number', () => {
    for (const age of [19, 20, 0, 24.5, 200, '24']) {
      put({ draft: { ...PICKED, age }, step: 5 });
      expect(myAiDraftStash.read()!.draft.age).toBeUndefined();
    }
    put({ draft: { ...PICKED, age: 21 }, step: 5 });
    expect(myAiDraftStash.read()!.draft.age).toBe(21);
  });

  it('drops unknown interests, duplicates and anything past the cap of three', () => {
    put({
      draft: { ...PICKED, interests: ['yoga', 'yoga', 'quidditch', 'travel', 'wine', 'anime'] },
      step: 5,
    });
    expect(myAiDraftStash.read()!.draft.interests).toEqual(['yoga', 'travel', 'wine']);
  });

  it('drops an empty or oversized name', () => {
    put({ draft: { ...PICKED, name: '   ' }, step: 5 });
    expect(myAiDraftStash.read()!.draft.name).toBeUndefined();
    put({ draft: { ...PICKED, name: 'M'.repeat(500) }, step: 5 });
    expect(myAiDraftStash.read()!.draft.name).toBeUndefined();
  });

  it('never reopens at a step the flow does not have', () => {
    put({ draft: PICKED, step: 9999 });
    expect(myAiDraftStash.read()!.step).toBeLessThanOrEqual(20);
    for (const step of [-3, 'five', null]) {
      put({ draft: PICKED, step });
      expect(myAiDraftStash.read()!.step).toBe(0);
    }
  });

  it('is nothing at all when the entry is not a draft', () => {
    store.set('over18.myAi.draft', 'not json');
    expect(myAiDraftStash.read()).toBeNull();
    put({ draft: 'a string', step: 5 });
    expect(myAiDraftStash.read()).toBeNull();
    put(['an', 'array']);
    expect(myAiDraftStash.read()).toBeNull();
  });
});

describe('the Sign in button on the review step', () => {
  it('is shown for a refused session and nothing else', () => {
    // A distinct error type, so the button does not hang on message wording.
    expect(new MyAiSignInRequired()).toBeInstanceOf(Error);
    expect(new MyAiSignInRequired().message).toContain('everything you picked is kept');
    expect(new Error('Sign in to create her')).not.toBeInstanceOf(MyAiSignInRequired);

    const flow = read('../components/my-ai/CreateFlow.tsx');
    expect(flow).toContain('setNeedsSignIn(e instanceof MyAiSignInRequired)');
    expect(flow).toContain('{needsSignIn && (');
  });

  it('goes to /login, comes back to /my-ai, and keeps the draft on the way', () => {
    const flow = read('../components/my-ai/CreateFlow.tsx');
    expect(flow).toContain('to="/login"');
    expect(flow).toContain("state={{ from: '/my-ai' }}");
    expect(flow).toContain('onClick={() => myAiDraftStash.write(draft, step)}');
    // And the wizard actually reopens on what was kept.
    expect(flow).toContain('useState(() => myAiDraftStash.read())');
    expect(flow).toContain('...restored?.draft,');
    expect(flow).toContain('myAiDraftStash.clear()');
  });

  it('is the page that decides a 401 means sign in, not a string match', () => {
    const page = read('../pages/MyAiPage.tsx');
    expect(page).toContain('throw new MyAiSignInRequired();');
  });
});
