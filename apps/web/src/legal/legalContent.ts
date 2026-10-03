/**
 * The legal and compliance documents, as data.
 *
 * ── WHY THE TEXT LIVES HERE AND NOT IN THE PAGES ─────────────────────────────
 *
 * Five pages rendering the same shape from one module means the structure is
 * asserted once, the placeholders are counted in one place, and a lawyer
 * replacing wording edits prose rather than JSX. It also lets a test prove the
 * thing that actually matters about a draft: that every unknown is visibly
 * marked, not quietly guessed.
 *
 * ── NOTHING HERE IS A LEGAL CLAIM WE HAVE NOT EARNED ─────────────────────────
 *
 * Company identity, address, governing law, regulators and contact addresses
 * are UNKNOWN to this codebase. They are rendered as `placeholder(...)`, which
 * is deliberately ugly so it cannot ship by accident. No registration number,
 * no licence, no certification and no regulator is named anywhere.
 *
 * ── AND NOTHING DESCRIBES FUNCTIONALITY THAT DOES NOT EXIST ──────────────────
 *
 * The cookie section lists the two cookies this application actually sets and
 * the four browser-storage keys it actually writes, read from the source. There
 * is no self-service cancellation, refund, data-export or account-deletion
 * flow in the product today, so the documents say requests are made by
 * contacting us -- they do not describe a button that is not there.
 */

/** The marker that makes an unknown impossible to miss, in prose or in a test. */
export const REPLACE_MARKER = 'REPLACE BEFORE PRODUCTION';

/** `[Legal entity name — REPLACE BEFORE PRODUCTION]` */
export function placeholder(what: string): string {
  return `[${what} — ${REPLACE_MARKER}]`;
}

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  slug: string;
  /** Footer and nav label. */
  label: string;
  title: string;
  eyebrow: string;
  summary: string;
  sections: LegalSection[];
}

const ENTITY = placeholder('Legal entity name');
const ADDRESS = placeholder('Registered address');
const CONTACT_EMAIL = placeholder('Contact email');
const PRIVACY_EMAIL = placeholder('Privacy contact email');
const SUPPORT_EMAIL = placeholder('Support contact email');
const REPORT_EMAIL = placeholder('Reporting contact email');
const GOVERNING_LAW = placeholder('Governing law and jurisdiction');
const EFFECTIVE_DATE = placeholder('Effective date');
const RETENTION_PERIOD = placeholder('Retention period');
const TRANSFER_MECHANISM = placeholder('International transfer mechanism');

/** Shown at the top of every document, so the draft status is never ambiguous. */
export const DRAFT_NOTICE =
  `This is a working draft prepared for the Staging environment. It has not been reviewed or approved by a lawyer, ` +
  `and every value marked ${REPLACE_MARKER} must be completed before it is published.`;

/* ------------------------------------------------------------------ *
 * Privacy
 * ------------------------------------------------------------------ */

const privacy: LegalDocument = {
  slug: 'privacy',
  label: 'Privacy Policy',
  title: 'Privacy Policy',
  eyebrow: 'Legal',
  summary: 'What we collect, why we hold it, and what you can ask us to do with it.',
  sections: [
    {
      heading: 'Who we are',
      paragraphs: [
        `Over18 is operated by ${ENTITY}, registered at ${ADDRESS}. This policy takes effect on ${EFFECTIVE_DATE}.`,
        `For anything in this policy, contact ${PRIVACY_EMAIL}.`,
      ],
    },
    {
      heading: 'Account information',
      bullets: [
        'Your email address and a hashed password. We never store your password itself.',
        'Your account role and status, and the dates your account was created and last updated.',
        'Server-side session records, so you can stay signed in and we can end a session.',
      ],
    },
    {
      heading: 'Usage and activity data',
      bullets: [
        'Characters you open, favourite, and start conversations with.',
        'Messages you send and receive in chat, stored so your conversations persist.',
        'Content you unlock, and the Credits those unlocks spend.',
        'First-party product analytics events — which screens and commercial steps were reached. These carry no free text, no email address and no URL.',
      ],
    },
    {
      heading: 'Technical and device information',
      paragraphs: [
        'Our servers record ordinary request logs in order to run and secure the service. Request bodies and cookie headers are deliberately excluded from logging.',
      ],
    },
    {
      heading: 'Cookies and browser storage',
      paragraphs: [
        'We set two cookies and write a small number of values into your own browser storage. They are listed in full in the Cookie Policy. We set no advertising cookies and no third-party tracking cookies.',
      ],
    },
    {
      heading: 'Payments and transactions',
      bullets: [
        'A record of each purchase: what was bought, the amount, the currency, the status, and a reference from the payment provider.',
        'Your Credits balance and a ledger of every movement in and out of it.',
        'We do not collect, receive or store card numbers. Card details are handled by the payment provider.',
      ],
    },
    {
      heading: 'AI and character interactions',
      paragraphs: [
        'Every character on Over18 is fictional and AI-generated. Your conversations are sent to an AI model provider so a reply can be produced.',
        'We also derive short factual notes from your conversations — for example a city you mentioned — so a character can remember them. These notes are tied to your account and the character, and you can ask us to delete them.',
      ],
    },
    {
      heading: 'Voice and live-call data',
      paragraphs: [
        'When you place a live voice call, your audio is relayed through our servers to a third-party voice provider, which produces the character’s speech.',
        'We store a transcript of the call and the same kind of short factual notes described above. We do not store the call audio itself.',
        'We record the technical details of the call — when it started and ended, how long it ran, and why it stopped.',
      ],
    },
    {
      heading: 'Why we process your information',
      bullets: [
        'To provide the service you asked for: your account, your conversations, your purchases and your calls.',
        'To take payment and keep an accurate record of what you bought and what you are owed.',
        'To keep the service secure, prevent abuse, and investigate misuse.',
        'To understand how the product is used, in aggregate, so it can be improved.',
        'To meet our legal and accounting obligations.',
      ],
    },
    {
      heading: 'Legal bases',
      paragraphs: [
        `The legal bases we rely on, and how they map to each purpose above, are to be confirmed with counsel: ${placeholder('Legal bases per processing purpose')}.`,
      ],
    },
    {
      heading: 'How long we keep it',
      paragraphs: [
        `Retention periods for account data, conversations, transcripts, derived notes, transaction records and logs are to be set: ${RETENTION_PERIOD}.`,
        'Transaction records are expected to be kept longer than other data, because tax and accounting rules require it.',
      ],
    },
    {
      heading: 'Service providers',
      paragraphs: [
        'We share information with the providers that run the service on our behalf: our hosting and database provider, our AI model provider, our live-voice provider, and our payment provider.',
        `The current list of providers, their roles and their locations is to be confirmed and published here: ${placeholder('Processor list with roles and locations')}.`,
      ],
    },
    {
      heading: 'International transfers',
      paragraphs: [
        `Some providers operate outside your country. The transfer mechanism we rely on is to be confirmed: ${TRANSFER_MECHANISM}.`,
      ],
    },
    {
      heading: 'Your rights',
      paragraphs: [
        'Depending on where you live, you may have the right to access your information, correct it, delete it, object to or restrict how we use it, and receive a copy in a portable form.',
        `There is no self-service tool for these requests in the product today. Make a request by contacting ${PRIVACY_EMAIL} and we will respond.`,
        `The supervisory authority you may complain to is to be confirmed: ${placeholder('Supervisory authority')}.`,
      ],
    },
    {
      heading: 'Security',
      bullets: [
        'Passwords are stored only as hashes.',
        'Session tokens are held in an HttpOnly cookie, so page scripts cannot read them, and only a hash of each token is stored on our side.',
        'Request logs deliberately exclude request bodies and cookie headers.',
        'No security measure is perfect, and we do not claim that ours is.',
      ],
    },
    {
      heading: 'Children and minors',
      paragraphs: [
        'Over18 is for adults aged 18 or over only. We do not knowingly collect information from anyone under 18.',
        `If you believe someone under 18 has created an account, contact ${REPORT_EMAIL} and we will act on it.`,
        'The age confirmation on entry is a self-declared check and is not identity verification. See the Adult / 18+ Policy.',
      ],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        'If we change this policy we will update this page and change the effective date above. Where a change is significant we will make it visible in the product.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: [`Privacy questions: ${PRIVACY_EMAIL}. General contact: ${CONTACT_EMAIL}.`],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Terms
 * ------------------------------------------------------------------ */

const terms: LegalDocument = {
  slug: 'terms',
  label: 'Terms & Conditions',
  title: 'Terms & Conditions',
  eyebrow: 'Legal',
  summary: 'The agreement between you and us when you use Over18.',
  sections: [
    {
      heading: 'The service',
      paragraphs: [
        `Over18, operated by ${ENTITY}, is an entertainment service offering conversations and live voice calls with fictional, AI-generated characters, together with photo and video content.`,
        `These terms take effect on ${EFFECTIVE_DATE}.`,
      ],
    },
    {
      heading: 'Eligibility — 18 or over',
      bullets: [
        'You must be at least 18 years old to use Over18.',
        'You must be old enough, where you live, for adult material to be lawful for you.',
        'Using the service if you are under 18 is a breach of these terms, and we will close the account.',
      ],
    },
    {
      heading: 'Your account',
      bullets: [
        'Give accurate information when you register, and keep it accurate.',
        'Keep your password to yourself. You are responsible for what happens under your account.',
        'One person per account. Do not share, sell or transfer your account.',
        'Tell us promptly if you think someone else has access to it.',
      ],
    },
    {
      heading: 'Acceptable use',
      bullets: [
        'Use Over18 for your own personal, non-commercial entertainment.',
        'Do not attempt to break, probe, overload or circumvent the service or its security.',
        'Do not scrape, copy, republish or redistribute content from the service.',
        'Do not use automated means to access the service.',
        'Do not misrepresent who you are or your age.',
      ],
    },
    {
      heading: 'Prohibited content and behaviour',
      paragraphs: [
        'The following are prohibited without exception, and we will act on them. The Adult / 18+ Policy sets them out in full.',
      ],
      bullets: [
        'Any sexual content involving minors, or presenting any person as a minor.',
        'Any content depicting non-consensual sexual activity.',
        'Content that is exploitative, abusive or involves coercion.',
        'Sexual content about a real, identifiable person without their consent.',
        'Content that is illegal where you are, or where we operate.',
      ],
    },
    {
      heading: 'AI and virtual characters',
      bullets: [
        'Every character is fictional and generated by artificial intelligence. No character is a real person.',
        'Images, voices and conversations are synthetic. No exchange on Over18 is with a human being.',
        'Characters can be wrong, inconsistent or say things we did not intend. Nothing a character says is advice of any kind.',
        'Do not rely on anything a character says for medical, legal, financial or personal decisions.',
      ],
    },
    {
      heading: 'Credits, subscriptions and purchases',
      bullets: [
        'Credits are a virtual item for use inside Over18. They have no cash value and cannot be exchanged for money.',
        'Credits are added to your balance once the payment provider confirms your payment.',
        'A Premium subscription renews for the billing period you chose, and includes Credits each cycle.',
        'Prices are shown before you confirm, in the currency displayed at the time.',
      ],
    },
    {
      heading: 'Cancellation and refunds',
      paragraphs: [
        'Stated plainly: the product does not currently provide a way to cancel a subscription or request a refund from within your account.',
        `Until it does, make any cancellation or refund request by contacting ${SUPPORT_EMAIL}.`,
        `The refund and cancellation terms themselves, including any statutory withdrawal right that applies to you, are to be set: ${placeholder('Refund and cancellation terms')}.`,
      ],
    },
    {
      heading: 'Intellectual property',
      paragraphs: [
        `The service, its software, its characters and all content on it belong to ${ENTITY} or its licensors.`,
        'You get a personal, non-transferable, revocable permission to use the service. Nothing here transfers ownership of anything to you.',
      ],
    },
    {
      heading: 'What you send us',
      paragraphs: [
        'Over18 does not offer public posting, profiles, uploads or comments. The only content you contribute is what you write in your own conversations.',
        'You keep whatever rights you have in what you write. You give us permission to process it so the service can work — to produce replies, to run the conversation, and to keep your history.',
      ],
    },
    {
      heading: 'Suspension and termination',
      bullets: [
        'You may stop using Over18 at any time.',
        'We may suspend or close an account that breaches these terms, particularly the prohibited content rules.',
        'Where an account is closed for a breach, unused Credits are forfeited.',
        `What happens to unused Credits when an account is closed for any other reason is to be set: ${placeholder('Credit forfeiture terms')}.`,
      ],
    },
    {
      heading: 'Disclaimers',
      paragraphs: [
        'Over18 is provided as it is. We do not promise it will be uninterrupted, error-free, or that a character will behave in any particular way.',
        'It is entertainment. It is not companionship advice, therapy, or a substitute for human relationships or professional help.',
      ],
    },
    {
      heading: 'Limitation of liability',
      paragraphs: [
        `The limits of our liability are to be set with counsel: ${placeholder('Limitation of liability clause')}.`,
        'Nothing in these terms will exclude liability that cannot lawfully be excluded.',
      ],
    },
    {
      heading: 'Governing law',
      paragraphs: [`These terms are governed by ${GOVERNING_LAW}.`],
    },
    {
      heading: 'Changes',
      paragraphs: [
        'We may change these terms. The current version is always on this page, with its effective date. Continuing to use Over18 after a change means you accept it.',
      ],
    },
    { heading: 'Contact', paragraphs: [`Questions about these terms: ${CONTACT_EMAIL}.`] },
  ],
};

/* ------------------------------------------------------------------ *
 * Adult / 18+
 * ------------------------------------------------------------------ */

const adultPolicy: LegalDocument = {
  slug: 'adult-policy',
  label: 'Adult / 18+ Policy',
  title: 'Adult / 18+ Policy',
  eyebrow: 'Safety',
  summary: 'Who Over18 is for, what is never allowed on it, and how to report something.',
  sections: [
    {
      heading: 'Adults only',
      paragraphs: [
        'Over18 contains sexually explicit material and is exclusively for adults aged 18 or over.',
        'Minors are prohibited from using this service. There is no part of it intended for anyone under 18.',
      ],
    },
    {
      heading: 'Age confirmation on entry',
      paragraphs: [
        'Before the site is shown, you are asked to confirm that you are 18 or over. If you say you are not, nothing is displayed.',
        'We state plainly what that check is: it is a self-declared confirmation. It is not identity verification, it is not age assurance, and we do not present it as either.',
        `Whether a stronger age-assurance method is required for you depends on where you are, and is being assessed: ${placeholder('Jurisdictional age-assurance requirements')}.`,
      ],
    },
    {
      heading: 'Never allowed',
      paragraphs: ['These rules have no exceptions and no appeal on principle.'],
      bullets: [
        'Sexual content involving minors, in any form, real or fictional, including any attempt to present a character or person as under 18.',
        'Any attempt to make a character appear to be a child, or to introduce children or childhood settings into sexual content.',
        'Sexual content depicting non-consent, coercion, or incapacity to consent.',
        'Content that is exploitative or abusive, or that depicts trafficking or sexual violence.',
        'Sexual content about a real, identifiable person who has not consented, including public figures.',
        'Content involving animals, or depicting serious injury or death.',
      ],
    },
    {
      heading: 'Our characters',
      paragraphs: [
        'Every character is fictional, AI-generated and presented as an adult. No character is based on a real person.',
        'Our character content is reviewed before it is published, and content that breaches the rules above is refused.',
        'Our live-voice provider applies its own independent content checks, and will refuse a call it considers in breach.',
      ],
    },
    {
      heading: 'Reporting',
      paragraphs: [
        `If you see anything that breaches this policy — above all anything involving a minor — report it to ${REPORT_EMAIL}.`,
        'Tell us what you saw and where. You do not need an account to report something.',
        `Our target response time for a report is to be set: ${placeholder('Report response time commitment')}.`,
      ],
    },
    {
      heading: 'Enforcement',
      bullets: [
        'We remove content that breaches this policy.',
        'We suspend or permanently close accounts that breach it.',
        'Where the law requires us to report something to an authority, we will.',
        `Our appeal process for an enforcement decision is to be set: ${placeholder('Appeals process')}.`,
      ],
    },
    { heading: 'Contact', paragraphs: [`Reports: ${REPORT_EMAIL}. Anything else: ${CONTACT_EMAIL}.`] },
  ],
};

/* ------------------------------------------------------------------ *
 * Cookies — the one document that is entirely factual
 * ------------------------------------------------------------------ */

const cookies: LegalDocument = {
  slug: 'cookies',
  label: 'Cookie Policy',
  title: 'Cookie Policy',
  eyebrow: 'Legal',
  summary: 'Every cookie we set and every value we keep in your browser, listed in full.',
  sections: [
    {
      heading: 'What we set',
      paragraphs: [
        'This list is taken from the application itself rather than from a template. Over18 sets two cookies. Both are first-party and both are strictly necessary.',
      ],
      bullets: [
        '`over18_session` — your sign-in session. HttpOnly, so page scripts cannot read it, and sent only to our own servers. It expires when your session does, and is cleared when you sign out.',
        '`o18_seen` — a single value, set on your first visit, that tells us whether to show you the first-visit version of the home screen. It holds no profile, no demographics, no location and no device fingerprint. It lasts one year.',
      ],
    },
    {
      heading: 'What we do not set',
      bullets: [
        'No advertising cookies.',
        'No third-party tracking cookies.',
        'No cross-site or social-network cookies.',
        'No third-party analytics cookies. Our product analytics are first-party: events are sent to our own server, and carry no free text, no email address and no URL.',
      ],
    },
    {
      heading: 'Values kept in your own browser',
      paragraphs: [
        'These are not cookies. They are stored by your browser, are never sent to us automatically, and are readable only by this site.',
      ],
      bullets: [
        '`over18.ageConfirmedAt` — the time you confirmed you are 18 or over, so you are not asked again on every visit. Expires after 30 days. Kept deliberately apart from cookie consent: confirming your age consents to nothing else.',
        '`over18.lastCharacterId` — the last character you were looking at, so the Credits Store can take you back there.',
        '`over18.credits.pendingPayment` — a payment in progress, kept only for the current tab, so your purchase result can be shown when you return.',
        '`over18.credits.pendingUnlock` — an unlock in progress, kept only for the current tab, for the same reason.',
      ],
    },
    {
      heading: 'Controlling them',
      paragraphs: [
        'You can clear or block cookies and site data in your browser settings. Clearing them signs you out and means you will be asked to confirm your age again.',
        `Whether a cookie consent banner is required for you depends on where you are. Since every cookie above is strictly necessary and we set no advertising or tracking cookies, this is to be confirmed with counsel: ${placeholder('Cookie consent requirement assessment')}.`,
      ],
    },
    { heading: 'Contact', paragraphs: [`Questions: ${PRIVACY_EMAIL}.`] },
  ],
};

/* ------------------------------------------------------------------ *
 * Legal / contact
 * ------------------------------------------------------------------ */

const legal: LegalDocument = {
  slug: 'legal',
  label: 'Contact / Legal',
  title: 'Contact & Legal',
  eyebrow: 'Legal',
  summary: 'Who operates Over18 and how to reach us.',
  sections: [
    {
      heading: 'Operator',
      bullets: [
        `Legal entity: ${ENTITY}`,
        `Registered address: ${ADDRESS}`,
        `Company registration: ${placeholder('Company registration number')}`,
        `VAT or tax registration: ${placeholder('VAT / tax registration number')}`,
      ],
    },
    {
      heading: 'How to reach us',
      bullets: [
        `General and legal: ${CONTACT_EMAIL}`,
        `Privacy and data requests: ${PRIVACY_EMAIL}`,
        `Billing and account support: ${SUPPORT_EMAIL}`,
        `Reporting prohibited content: ${REPORT_EMAIL}`,
      ],
    },
    {
      heading: 'Our documents',
      paragraphs: [
        'The Privacy Policy, Terms & Conditions, Adult / 18+ Policy and Cookie Policy are linked from the footer of every page.',
      ],
    },
    {
      heading: 'Status of these documents',
      paragraphs: [
        'These are working drafts. Every value marked for replacement must be completed, and the whole set reviewed by a lawyer, before any of it is relied on.',
      ],
    },
  ],
};

/** Every legal document, in the order the footer lists them. */
export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [privacy, terms, adultPolicy, cookies, legal];

export function legalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((doc) => doc.slug === slug);
}

/** Every placeholder still awaiting a real value, for the report and for a test. */
export function outstandingPlaceholders(): string[] {
  const found = new Set<string>();
  for (const doc of LEGAL_DOCUMENTS) {
    for (const section of doc.sections) {
      for (const text of [...(section.paragraphs ?? []), ...(section.bullets ?? [])]) {
        for (const match of text.matchAll(/\[([^\]]+?) — REPLACE BEFORE PRODUCTION\]/g)) {
          found.add(match[1] as string);
        }
      }
    }
  }
  return [...found].sort();
}
