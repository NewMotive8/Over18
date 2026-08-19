import { describe, expect, it } from 'vitest';
import { LlmError, type LlmClient, type LlmRequest } from '../llm/types.js';
import {
  ProfileAuthorError,
  buildProfilePrompt,
  createLlmProfileAuthor,
  extractJsonObject,
  toProfileDraft,
  unconfiguredProfileAuthor,
} from '../services/character-profile-service.js';

/**
 * Autofill's parsing and failure behaviour, with no database and no network.
 *
 * The point of these is that a model reply is UNTRUSTED input: it is about to
 * become a character an operator saves, so a partial or malformed reply must
 * fail loudly rather than half-fill a profile.
 */

const GOOD = {
  displayName: 'Nova',
  shortBio: 'Night-shift astronomer.',
  personality: 'Wry, unhurried.',
  conversationStyle: 'Asks questions back.',
  systemPrompt: 'You are Nova, a fictional adult woman.',
  interests: ['astronomy', 'jazz'],
};

function clientReturning(raw: string, capture?: LlmRequest[]): LlmClient {
  return {
    generate: async (request) => {
      capture?.push(request);
      return raw;
    },
  };
}

describe('extracting the model reply', () => {
  it('reads a bare object, a fenced one, and one buried in prose', async () => {
    const json = JSON.stringify(GOOD);
    expect(extractJsonObject(json)).toMatchObject({ displayName: 'Nova' });
    expect(extractJsonObject('```json\n' + json + '\n```')).toMatchObject({ displayName: 'Nova' });
    expect(extractJsonObject(`Sure! Here you go:\n${json}\nHope that helps.`)).toMatchObject({
      displayName: 'Nova',
    });
  });

  it('refuses a reply with no object, and one that is malformed', () => {
    expect(() => extractJsonObject('I would rather not.')).toThrow(ProfileAuthorError);
    expect(() => extractJsonObject('{ "shortBio": ')).toThrow(ProfileAuthorError);
  });
});

describe('validating a draft', () => {
  it('accepts a complete profile and trims it', () => {
    const draft = toProfileDraft({ ...GOOD, shortBio: '  spaced  ' }, 'Fallback');
    expect(draft.shortBio).toBe('spaced');
    expect(draft.interests).toEqual(['astronomy', 'jazz']);
  });

  it('fails on a PARTIAL profile rather than saving half a character', () => {
    for (const field of ['shortBio', 'personality', 'conversationStyle', 'systemPrompt']) {
      const partial: Record<string, unknown> = { ...GOOD };
      delete partial[field];
      expect(() => toProfileDraft(partial, 'Fallback'), field).toThrow(ProfileAuthorError);
      expect(() => toProfileDraft({ ...GOOD, [field]: '   ' }, 'Fallback'), field).toThrow(
        ProfileAuthorError,
      );
    }
    expect(() => toProfileDraft('not an object', 'Fallback')).toThrow(ProfileAuthorError);
    expect(() => toProfileDraft(null, 'Fallback')).toThrow(ProfileAuthorError);
  });

  it('keeps the name she already has when the model omits it', () => {
    // Her identity is not the model's to invent — but a missing name is not
    // worth throwing the whole draft away over.
    const { displayName } = toProfileDraft({ ...GOOD, displayName: '  ' }, 'Existing Name');
    expect(displayName).toBe('Existing Name');
  });

  it('tolerates a junk interests list without letting it through unbounded', () => {
    const draft = toProfileDraft(
      { ...GOOD, interests: [1, 'astronomy', null, '  ', ...Array(20).fill('x')] },
      'Fallback',
    );
    expect(draft.interests.length).toBeLessThanOrEqual(8);
    expect(draft.interests).toContain('astronomy');
    expect(draft.interests.every((i) => typeof i === 'string' && i.length > 0)).toBe(true);
    expect(toProfileDraft({ ...GOOD, interests: 'astronomy' }, 'F').interests).toEqual([]);
  });
});

describe('the instruction set', () => {
  it('states the adult rule and varies by seed', () => {
    const messages = buildProfilePrompt({ displayName: 'Nova', variationSeed: 'seed-123' });
    const all = messages.map((m) => m.content).join('\n');
    expect(all).toContain('FICTIONAL ADULT');
    expect(all).toContain('Never write a minor');
    expect(all).toContain('Nova');
    expect(all).toContain('seed-123');
  });
});

describe('the author', () => {
  it('turns a model reply into a draft, and passes the prompt through', async () => {
    const seen: LlmRequest[] = [];
    const author = createLlmProfileAuthor(clientReturning(JSON.stringify(GOOD), seen));
    const draft = await author({ displayName: 'Nova', variationSeed: 's1' });
    expect(draft.systemPrompt).toContain('You are Nova');
    expect(seen[0]!.messages[0]!.role).toBe('system');
    expect(seen[0]!.temperature).toBeGreaterThan(0); // re-rolls must differ
  });

  it('never leaks provider detail when inference fails', async () => {
    const secretish = 'HTTP 401 from https://provider.invalid key=sk-do-not-leak';
    const author = createLlmProfileAuthor({
      generate: async () => {
        throw new LlmError('http', secretish, 401);
      },
    });
    const error = await author({ displayName: 'Nova', variationSeed: 's1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ProfileAuthorError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toContain('sk-do-not-leak');
    expect(error.message).not.toContain('provider.invalid');
  });

  it('distinguishes "not configured" and "timed out" for the operator', async () => {
    const notConfigured = await createLlmProfileAuthor({
      generate: async () => {
        throw new LlmError('not_configured', 'no endpoint');
      },
    })({ displayName: 'N', variationSeed: 's' }).catch((e) => e);
    expect(notConfigured.kind).toBe('not_configured');

    const timedOut = await createLlmProfileAuthor({
      generate: async () => {
        throw new LlmError('timeout', 'took too long');
      },
    })({ displayName: 'N', variationSeed: 's' }).catch((e) => e);
    expect(timedOut.kind).toBe('unavailable');
    expect(timedOut.message).toContain('too long');
  });

  it('the unconfigured author refuses rather than faking a profile', async () => {
    const error = await Promise.resolve()
      .then(() => unconfiguredProfileAuthor({ displayName: 'N', variationSeed: 's' }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(ProfileAuthorError);
    expect(error.kind).toBe('not_configured');
    expect(error.message).toContain('by hand');
  });
});
