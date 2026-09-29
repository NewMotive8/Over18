import { describe, expect, it } from 'vitest';
import { compareProfileAndPersona } from '@over18/shared';

/**
 * The rule behind the Admin divergence warning.
 *
 * Its job is to be worth reading. A comparison that flags every phrasing
 * difference gets ignored within a day, and one that misses "Bollywood actress
 * versus marketing coordinator" is not worth having -- so the cases below are
 * drawn from the live roster rather than invented, and the wording-difference
 * cases matter as much as the contradictions.
 *
 * It is not a classifier and does not pretend to be: synonyms defeat it, and
 * that limitation is asserted at the bottom rather than hidden.
 */

const compare = compareProfileAndPersona;

describe('occupations that agree', () => {
  it('matches a job title stated plainly in her bio', () => {
    const r = compare({
      shortBio: 'Camila is a physiotherapist at a neighbourhood clinic who spends her days on her feet.',
      personality: 'Warm and direct.',
      personaOccupation: 'physiotherapist',
    });
    expect(r.status).toBe('consistent');
    expect(r.sharedWords).toContain('physiotherapist');
  });

  /**
   * THE EMPLOYER CLAUSE IS NOT THE JOB. A long persona occupation still agrees
   * with a short bio when the job itself matches.
   */
  it('ignores the employer clause when matching', () => {
    const r = compare({
      shortBio: 'Julia teaches mathematics to teenagers and marks books after dinner.',
      personality: '',
      personaOccupation: 'mathematics teacher at a state secondary school a short bus ride from her flat',
    });
    expect(r.status).toBe('consistent');
    expect(r.sharedWords).toContain('mathematics');
  });

  it('accepts a match found only in her personality text', () => {
    const r = compare({
      shortBio: '',
      personality: 'She carries the calm of someone used to being a nurse on long shifts.',
      personaOccupation: 'nurse',
    });
    expect(r.status).toBe('consistent');
    expect(r.publicFields).toEqual(['personality']);
  });

  /** One shared word is enough: the two texts are written to different briefs. */
  it('matches on a single significant word', () => {
    const r = compare({
      shortBio: 'Batya is a flight attendant in her mid-twenties spending a night off in the city.',
      personality: '',
      personaOccupation: 'flight attendant',
    });
    expect(r.status).toBe('consistent');
  });
});

describe('occupations that genuinely conflict', () => {
  /** Indira, from the live roster. */
  it('flags a Bollywood actress against a marketing coordinator', () => {
    const r = compare({
      shortBio: 'Indira is a marketing coordinator on a short break in Agra, photographed on her balcony.',
      personality: 'Playful and quick.',
      personaOccupation: 'Famous Bollywood actress',
    });
    expect(r.status).toBe('diverged');
    expect(r.summary).toContain('Famous Bollywood actress');
    expect(r.summary).toMatch(/bio and personality do not mention that/);
  });

  /** Mika, from the live roster. */
  it('flags a marketing manager against a banker', () => {
    const r = compare({
      shortBio: 'Mika is a 38-year-old Banker who lives in a bright, plant-filled apartment.',
      personality: '',
      personaOccupation: 'marketing manager',
    });
    expect(r.status).toBe('diverged');
  });

  /** Nova, from the live roster. */
  it('flags a graphic designer against an astrophotographer', () => {
    const r = compare({
      shortBio: "I'm Nova, an eccentric ex-planetarium curator turned deep-space astrophotographer.",
      personality: 'Enthusiastic yet quietly intense.',
      personaOccupation: 'graphic designer at a mid-size advertising agency',
    });
    expect(r.status).toBe('diverged');
    expect(r.sharedWords).toEqual([]);
  });

  /**
   * THE WORKPLACE MUST NOT VOUCH FOR THE JOB. A bio that happens to mention a
   * studio says nothing about whether she is a copywriter in it.
   */
  it('does not let a shared workplace noun excuse a different job', () => {
    const r = compare({
      shortBio: 'Genie is a graphic designer who spends most weekdays in a small studio.',
      personality: '',
      personaOccupation: 'Copywriter at a small branding studio a short tram ride from her flat',
    });
    expect(r.status).toBe('diverged');
    expect(r.sharedWords, '"studio" and "small" must not count').toEqual([]);
  });
});

describe('wording differences that are NOT contradictions', () => {
  it('does not flag a different sentence about the same job', () => {
    const r = compare({
      shortBio: 'She works as a dentist and cycles to the surgery most mornings.',
      personality: 'Precise, unhurried, a little dry.',
      personaOccupation: 'dentist at a busy high-street practice a ten-minute walk from her flat',
    });
    expect(r.status).toBe('consistent');
  });

  it('is unmoved by tone, interests or personality differing in wording', () => {
    // Only the occupation pair is compared -- everything else may differ freely.
    const r = compare({
      shortBio: 'Kim is a fitness instructor who likes early starts.',
      personality: 'Sardonic where her persona is described as warm.',
      personaOccupation: 'fitness instructor at a high-street gym and leisure centre',
    });
    expect(r.status).toBe('consistent');
  });

  it('matches regardless of capitalisation and punctuation', () => {
    const r = compare({
      shortBio: 'Jeri: a HORSEBACK-RIDING instructor, most weekends.',
      personality: '',
      personaOccupation: 'Horseback Riding Instructor',
    });
    expect(r.status).toBe('consistent');
  });
});

describe('missing information is reported as missing, never as conflict', () => {
  it('reports no persona occupation', () => {
    const r = compare({
      shortBio: 'She is a teacher.',
      personality: 'Kind.',
      personaOccupation: null,
    });
    expect(r.status).toBe('incomplete');
    expect(r.summary).toMatch(/does not state an occupation/);
    expect(r.personaOccupation).toBeNull();
  });

  it('reports an empty public profile', () => {
    const r = compare({ shortBio: '', personality: '   ', personaOccupation: 'nurse' });
    expect(r.status).toBe('incomplete');
    expect(r.summary).toMatch(/no bio or personality text/);
    expect(r.publicFields).toEqual([]);
  });

  it('reports both sides missing', () => {
    const r = compare({ shortBio: null, personality: null, personaOccupation: undefined });
    expect(r.status).toBe('incomplete');
  });

  /** An occupation of only generic words leaves nothing testable. */
  it('reports an occupation with no comparable words', () => {
    const r = compare({
      shortBio: 'She has a job in the city.',
      personality: '',
      personaOccupation: 'at a company',
    });
    expect(r.status).toBe('incomplete');
    expect(r.summary).toMatch(/not in words specific enough/);
  });
});

describe('what the warning always carries', () => {
  it('returns both sides verbatim so an operator can judge for themselves', () => {
    const r = compare({
      shortBio: 'Indira is a marketing coordinator.',
      personality: '',
      personaOccupation: 'Famous Bollywood actress',
    });
    // The point of showing both: the rule reports, the operator decides.
    expect(r.personaOccupation).toBe('Famous Bollywood actress');
    expect(r.publicText).toContain('marketing coordinator');
    expect(r.publicFields).toEqual(['shortBio']);
  });

  /**
   * THE HONEST LIMIT. Synonyms defeat a word comparison, and pretending
   * otherwise would be worse than documenting it: a "consistent" result means
   * no contradiction was DETECTED, never that the two agree.
   */
  it('cannot see through synonyms, and this is asserted rather than hidden', () => {
    const r = compare({
      shortBio: 'Melanie is a solicitor in the city.',
      personality: '',
      personaOccupation: 'lawyer',
    });
    expect(r.status, 'a synonym reads as divergence -- a known false positive').toBe('diverged');
  });

  it('can be fooled by a shared generic job word', () => {
    const r = compare({
      shortBio: 'She is a hotel manager.',
      personality: '',
      personaOccupation: 'marketing manager',
    });
    expect(r.status, 'a shared "manager" hides a real difference').toBe('consistent');
  });
});
