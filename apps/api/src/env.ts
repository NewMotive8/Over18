/**
 * Central, fail-fast environment access.
 *
 * DATABASE_URL is required: the process exits with a clear message when it is
 * missing. Its value is never logged anywhere.
 */

import { fakeProvidersAllowed } from './commerce/fake-provider-policy.js';

export interface LlmEnv {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  contextMaxMessages: number;
  contextMaxChars: number;
}

/**
 * Vision-capable inference config (Phase 2 avatar-derived persona).
 *
 * NO NEW CONFIG IS REQUIRED to use it: every field defaults to the matching
 * LLM_* value, so if the already-configured chat endpoint happens to be
 * vision-capable, persona generation just works. PERSONA_VISION_* exists
 * purely as an override seam for pointing this ONE feature at a different
 * model/endpoint later without touching chat or Autofill's configuration.
 * Still provider-neutral by construction — nothing here names a vendor.
 */
export interface VisionEnv {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export interface MemoryEnv {
  maxInjected: number;
  maxInjectedChars: number;
  maxStored: number;
}

export interface MediaEnv {
  storageDir: string;
  publicBaseUrl: string | null;
  internalToken: string | null;
  ledgerPath: string;
  /**
   * Whether a verified optimised derivative may be served in place of the
   * original upload. OFF unless MEDIA_OPTIMISED_ENABLED is exactly "true".
   *
   * THIS IS THE ROLLBACK. Setting it back to anything else returns every
   * surface — Home, the Character page, Discover, chat, admin preview — to the
   * original files on the very next request. No file is moved, no row is
   * rewritten and no deploy is needed, because the derivative is an ADDITIONAL
   * file recorded in an ADDITIONAL provenance key: turning this off simply
   * stops anything reading that key.
   *
   * Default OFF, deliberately. A derivative that exists on disk and is
   * recorded on the row is still inert until an operator turns this on, so
   * shipping the machinery and shipping the behaviour are two separate
   * decisions.
   */
  optimisedEnabled: boolean;
  atlas: {
    baseUrl: string;
    imageModel: string;
    videoModel: string;
    live: boolean;
  };
  runpod: {
    endpointId: string | null;
    live: boolean;
    preferForImages: boolean;
  };
}

/**
 * Character Media Messages. OFF unless CHAT_MEDIA_ENABLED is exactly "true".
 *
 * "Off" does not mean "select an asset then hide it" — it means no selector is
 * constructed at all (see app.ts), so the eligibility query never runs and
 * media_asset_id is never written. The kill switch is structural, not cosmetic.
 */
/**
 * Live voice calls (SpicyAPI). Null unless SPICYAPI_API_KEY is set, so an
 * unconfigured environment has no provider object at all rather than one that
 * fails on use.
 */
export interface VoiceEnv {
  provider: 'spicyapi';
  apiKey: string;
  timeoutMs: number;
  /** The application ceiling. Clamped to the provider's 780s in the adapter. */
  maxSeconds: number;
}

/**
 * The live-call kill switch, SEPARATE from whether a provider is configured.
 *
 * Two independent conditions have to hold before a call can start: a provider
 * must exist, and calls must be switched on. They are separate because Phase 1
 * ships the session lifecycle with no relay and no billing -- so the key can be
 * present, and the feature still must not be reachable. Off unless
 * VOICE_CALLS_ENABLED is exactly "true".
 */
export interface VoiceCallsEnv {
  enabled: boolean;
}

export interface ChatMediaEnv {
  enabled: boolean;
}

/**
 * Admin -> Generation: prompts to xAI, images to one Google Drive folder.
 *
 * BOTH HALVES FOLLOW THE `MEDIA_LIVE_CONFIRM` RULE that has kept this
 * repository from spending money by accident: a paid provider is reached only
 * when a confirm flag AND a key are both present. Absent either, a mock runs
 * and the whole workspace — queue, states, retries, uploads — is exercisable
 * for nothing.
 *
 * NOTHING IN HERE EVER REACHES A BROWSER. The web app receives batch rows and
 * Drive links; never a key, a client secret, a refresh token or a spool path.
 */
export interface PromptGenerationEnv {
  xai: {
    baseUrl: string;
    model: string;
    apiKey: string | null;
    timeoutMs: number;
    maxAttempts: number;
    /** Kept under xAI's published 6 req/s for grok-imagine-image-2.0. */
    requestsPerSecond: number;
    maxConcurrent: number;
    live: boolean;
  };
  drive: {
    clientId: string | null;
    clientSecret: string | null;
    refreshToken: string | null;
    /**
     * OPTIONAL, AND NORMALLY UNSET. A legacy override for pinning a folder
     * this application created earlier — after a database restore, say.
     *
     * It is NOT the way to choose a destination any more, because it cannot
     * be: the scope is `drive.file`, so a folder the operator makes by hand in
     * the Drive web UI is invisible to this application and every upload into
     * it fails with 404 `notFound`. Left unset, the app creates and remembers
     * its own folder, which is the only kind it can address.
     */
    folderId: string | null;
    timeoutMs: number;
    live: boolean;
    /**
     * Endpoint overrides, defaulting to Google.
     *
     * They exist so the REAL client — the same OAuth exchange and the same
     * multipart upload — can be pointed at a local stand-in during end-to-end
     * verification, instead of that path being covered only by an in-memory
     * fake it does not share code with. Unset in production, where they fall
     * back to Google's own URLs.
     */
    tokenUrl: string | null;
    uploadUrl: string | null;
    filesUrl: string | null;
    redirectUri: string | null;
    tokenEncryptionKey: string | null;
    userinfoUrl: string | null;
    authUrl: string | null;
  };
  /** Where generated bytes wait between xAI and Drive. Never served. */
  spoolDir: string;
}

/**
 * Admin roles and audit (PRD v1.2 §34). BOTH SWITCHES DEFAULT OFF.
 *
 * `permissionsEnforced` OFF means `requirePermission` behaves exactly like
 * `requireAdmin`: any staff member passes. That is what makes shipping the role
 * model dark safe -- nobody can be locked out of the admin by a deploy, and
 * enforcement is switched on only once every operator holds the grants they
 * need.
 *
 * `auditEnabled` OFF means the generic admin-write hook records nothing. Role
 * changes are audited regardless, because that route is new and the audit row
 * is written in the same transaction as the change it describes.
 */
export interface AdminEnv {
  auditEnabled: boolean;
  permissionsEnforced: boolean;
}

/**
 * The chat providers that are permanently configured side by side.
 *
 * Each one keeps its OWN base URL, model and key, always set, so switching her
 * voice is one variable and never a credential edit. Adding a third means a
 * name here and a block in `resolveChatLlm` — nothing else.
 */
export const CHAT_LLM_PROVIDERS = ['grok', 'spicyapi'] as const;
export type ChatLlmProviderName = (typeof CHAT_LLM_PROVIDERS)[number];

/** Per-provider variable prefix. `CHAT_GROK_MODEL`, `CHAT_SPICYAPI_MODEL`, … */
const CHAT_PROVIDER_PREFIX: Record<ChatLlmProviderName, string> = {
  grok: 'CHAT_GROK',
  spicyapi: 'CHAT_SPICYAPI',
};

/** The only providers that exist before a vendor is chosen (D-4, D-8). */
export type CommerceProviderName = 'none' | 'fake';

/**
 * Subscription and App Economy (PRD v1.2). EVERYTHING DEFAULTS OFF.
 *
 * `enabled` is the master switch for TAKING MONEY. It exists so every phase
 * lands behind one flag rather than inventing its own: the economy catalog, a
 * customer's commercial state, the unlock and every payment route answer 503
 * while it is off, and no commercial write is accepted.
 *
 * IT IS NOT A SWITCH ON CONTENT. What a clip costs to see is an editorial fact
 * about the content, needing no payment provider, so classifying a clip Free or
 * Premium and resolving a customer's access to it both work with the flag off
 * and behave identically in every environment. An environment without a PSP
 * cannot complete a purchase; it still shows the same free and locked content.
 * See `services/commercial-boundary.ts` (`classifyContentAccess`).
 *
 * A `fake` provider can NEVER be active in production: `loadEnv` maps it to
 * `none` unless NODE_ENV is explicitly development/test AND the process is not
 * on Railway, and the provider selectors refuse it independently on the same
 * rule. An unset NODE_ENV counts as production. A fake payment provider that
 * reached production would grant Credits for nothing.
 */
export interface CommerceEnv {
  enabled: boolean;
  paymentProvider: CommerceProviderName;
  ageVerificationProvider: CommerceProviderName;
  analyticsEnabled: boolean;
}

export interface Env {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigin: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  sessionTtlDays: number;
  isProduction: boolean;
  llm: LlmEnv | null;
  /**
   * The endpoint CHARACTER CHAT talks to — her replies and her opening line.
   *
   * Separate from `llm` because the chat model is a PRODUCT choice that gets
   * changed and compared, while memory extraction and Admin Autofill are
   * plumbing that must keep working the same way whichever model she speaks
   * through. Before this existed, trying a different chat model meant
   * repointing `LLM_*`, which silently dragged those two along with it — and
   * both parse structured output, so a model that could chat but not follow a
   * format degraded them invisibly rather than loudly.
   *
   * Equal to `llm` when `CHAT_LLM_PROVIDER` is unset, so an environment that
   * never heard of this behaves exactly as it did.
   */
  chatLlm: LlmEnv | null;
  personaVision: VisionEnv | null;
  memory: MemoryEnv;
  media: MediaEnv;
  chatMedia: ChatMediaEnv;
  voice: VoiceEnv | null;
  voiceCalls: VoiceCallsEnv;
  promptGeneration: PromptGenerationEnv;
  admin: AdminEnv;
  commerce: CommerceEnv;
}

/** True for "true" / "TRUE" / " true " — ignores accidental whitespace. */
function envFlagTrue(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Which endpoint character chat talks to.
 *
 * THE RULE IS: SAY NOTHING AND NOTHING CHANGES; NAME A PROVIDER AND IT MUST BE
 * COMPLETE. With `CHAT_LLM_PROVIDER` unset chat keeps using `LLM_*`, exactly as
 * every environment does today. Name one and its three variables must all be
 * there — a half-configured provider is FATAL at boot, never a quiet fall back
 * to the other one. Falling back would be the worst possible failure here:
 * chat would keep working, so nobody would look, while every reply came from a
 * model nobody chose. A process that refuses to start is noticed in a minute.
 *
 * Timeout, token and context limits stay SHARED (`LLM_*`). They are tuning, not
 * identity, and giving each provider its own set would mean a model swap
 * quietly changed the history window too.
 */
function resolveChatLlm(fallback: LlmEnv | null): LlmEnv | null {
  const raw = (process.env.CHAT_LLM_PROVIDER ?? '').trim();
  if (raw.length === 0) return fallback;

  const name = raw.toLowerCase() as ChatLlmProviderName;
  if (!CHAT_LLM_PROVIDERS.includes(name)) {
    console.error(
      `FATAL: unsupported CHAT_LLM_PROVIDER "${raw}" (supported: ${CHAT_LLM_PROVIDERS.join('|')}).`,
    );
    process.exit(1);
  }

  const prefix = CHAT_PROVIDER_PREFIX[name];
  const baseUrl = (process.env[`${prefix}_BASE_URL`] ?? '').trim();
  const model = (process.env[`${prefix}_MODEL`] ?? '').trim();
  const apiKey = (process.env[`${prefix}_API_KEY`] ?? '').trim();

  const missing = [
    baseUrl ? null : `${prefix}_BASE_URL`,
    model ? null : `${prefix}_MODEL`,
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    console.error(
      `FATAL: CHAT_LLM_PROVIDER is "${name}" but ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } missing. Chat will not silently use another provider.`,
    );
    process.exit(1);
  }

  return {
    provider: 'openai-compatible',
    baseUrl,
    model,
    // Absent is legitimate: a self-hosted endpoint may be keyless, exactly as
    // LLM_API_KEY is optional above.
    apiKey: apiKey || undefined,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 512),
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.8),
    contextMaxMessages: Number(process.env.LLM_CONTEXT_MAX_MESSAGES ?? 40),
    contextMaxChars: Number(process.env.LLM_CONTEXT_MAX_CHARS ?? 16_000),
  };
}

/**
 * `fake` only where fakes are explicitly allowed (fail closed -- see
 * commerce/fake-provider-policy.ts); anything else, or nothing, is `none`.
 */
function commerceProvider(name: string): CommerceProviderName {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  return value === 'fake' && fakeProvidersAllowed(process.env) ? 'fake' : 'none';
}

function envNonEmpty(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'FATAL: DATABASE_URL is not set. ' +
        'Provide a PostgreSQL connection string via the DATABASE_URL environment variable ' +
        '(on Railway this is injected automatically; locally, copy apps/api/.env.example to .env).',
    );
    process.exit(1);
  }

  const sameSite = process.env.COOKIE_SAMESITE ?? 'lax';
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    console.error(`FATAL: COOKIE_SAMESITE must be one of lax|strict|none, got "${sameSite}".`);
    process.exit(1);
  }

  let llm: LlmEnv | null = null;
  if (process.env.LLM_BASE_URL) {
    const model = process.env.LLM_MODEL;
    if (!model) {
      console.error('FATAL: LLM_BASE_URL is set but LLM_MODEL is missing.');
      process.exit(1);
    }
    const provider = process.env.LLM_PROVIDER ?? 'openai-compatible';
    if (provider !== 'openai-compatible') {
      console.error(`FATAL: unsupported LLM_PROVIDER "${provider}" (supported: openai-compatible).`);
      process.exit(1);
    }
    llm = {
      provider,
      baseUrl: process.env.LLM_BASE_URL,
      model,
      apiKey: process.env.LLM_API_KEY || undefined,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 512),
      temperature: Number(process.env.LLM_TEMPERATURE ?? 0.8),
      contextMaxMessages: Number(process.env.LLM_CONTEXT_MAX_MESSAGES ?? 40),
      contextMaxChars: Number(process.env.LLM_CONTEXT_MAX_CHARS ?? 16_000),
    };
  }

  const chatLlm = resolveChatLlm(llm);

  // Defaults entirely to the LLM_* config resolved above: PERSONA_VISION_*
  // overrides individual fields only when set. No baseUrl (from either
  // source) means no vision config at all — selectPersonaGenerator reports
  // itself unconfigured rather than guessing.
  const visionBaseUrl = process.env.PERSONA_VISION_BASE_URL || llm?.baseUrl;
  const visionModel = process.env.PERSONA_VISION_MODEL || llm?.model;
  let personaVision: VisionEnv | null = null;
  if (visionBaseUrl && visionModel) {
    personaVision = {
      provider: 'openai-compatible',
      baseUrl: visionBaseUrl,
      model: visionModel,
      apiKey: process.env.PERSONA_VISION_API_KEY || llm?.apiKey,
      timeoutMs: Number(process.env.PERSONA_VISION_TIMEOUT_MS ?? llm?.timeoutMs ?? 45_000),
      maxTokens: Number(process.env.PERSONA_VISION_MAX_TOKENS ?? 700),
      temperature: Number(process.env.PERSONA_VISION_TEMPERATURE ?? 0.4),
    };
  }

  /**
   * The live-voice provider. Gated on the key alone: there is nothing else to
   * configure, and a half-configured provider is worse than none.
   */
  const spicyKey = (process.env.SPICYAPI_API_KEY ?? '').trim();
  const voice: VoiceEnv | null = spicyKey
    ? {
        provider: 'spicyapi',
        apiKey: spicyKey,
        timeoutMs: Number(process.env.VOICE_SESSION_TIMEOUT_MS ?? 10_000),
        maxSeconds: Number(process.env.VOICE_MAX_SECONDS ?? 780),
      }
    : null;

  const runpodEndpointId = (process.env.RUNPOD_ENDPOINT_ID ?? '').trim() || null;

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    cookieSecure:
      (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')).trim() ===
      'true',
    cookieSameSite: sameSite,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
    isProduction: process.env.NODE_ENV === 'production',
    llm,
    chatLlm,
    personaVision,
    memory: {
      maxInjected: Number(process.env.MEMORY_MAX_INJECTED ?? 10),
      maxInjectedChars: Number(process.env.MEMORY_MAX_INJECTED_CHARS ?? 2_000),
      maxStored: Number(process.env.MEMORY_MAX_STORED ?? 100),
    },
    // Default OFF: anything other than exactly "true" leaves chat text-only.
    chatMedia: { enabled: envFlagTrue('CHAT_MEDIA_ENABLED') },
    voice,
    voiceCalls: { enabled: envFlagTrue('VOICE_CALLS_ENABLED') },
    admin: {
      auditEnabled: envFlagTrue('ADMIN_AUDIT_ENABLED'),
      permissionsEnforced: envFlagTrue('ADMIN_PERMISSIONS_ENFORCED'),
    },
    commerce: {
      enabled: envFlagTrue('ECONOMY_ENABLED'),
      paymentProvider: commerceProvider('PAYMENT_PROVIDER'),
      ageVerificationProvider: commerceProvider('AGE_VERIFICATION_PROVIDER'),
      analyticsEnabled: envFlagTrue('ANALYTICS_ENABLED'),
    },
    media: {
      storageDir: process.env.MEDIA_STORAGE_DIR ?? 'var/media',
      publicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || null,
      internalToken: process.env.INTERNAL_MEDIA_TOKEN || null,
      ledgerPath: process.env.MEDIA_LEDGER_PATH ?? 'var/media/cost-ledger.json',
      // Default OFF: anything other than exactly "true" serves originals.
      optimisedEnabled: envFlagTrue('MEDIA_OPTIMISED_ENABLED'),
      atlas: {
        baseUrl: process.env.ATLAS_BASE_URL ?? 'https://api.atlascloud.ai/api/v1',
        imageModel: process.env.ATLAS_IMAGE_MODEL ?? 'black-forest-labs/flux-kontext-dev',
        videoModel: process.env.ATLAS_VIDEO_MODEL ?? 'atlascloud/wan-2.7-spicy/image-to-video',
        live: envFlagTrue('MEDIA_LIVE_CONFIRM') && envNonEmpty('ATLASCLOUD_API_KEY'),
      },
      runpod: {
        endpointId: runpodEndpointId,
        live:
          envFlagTrue('MEDIA_RUNPOD_CONFIRM') &&
          envNonEmpty('RUNPOD_API_KEY') &&
          Boolean(runpodEndpointId),
        preferForImages: (process.env.MEDIA_IMAGE_PROVIDER ?? 'runpod').trim().toLowerCase() !== 'atlas',
      },
    },
    promptGeneration: {
      xai: {
        baseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
        model: process.env.XAI_IMAGE_MODEL ?? 'grok-imagine-image-2.0',
        apiKey: process.env.XAI_API_KEY || null,
        timeoutMs: Number(process.env.XAI_TIMEOUT_MS ?? 120_000),
        maxAttempts: Number(process.env.XAI_MAX_ATTEMPTS ?? 3),
        // xAI documents 6 req/s for this model. We sit under it rather than on
        // it, because the published figure is a ceiling and not a target.
        requestsPerSecond: Number(process.env.XAI_REQUESTS_PER_SECOND ?? 4),
        maxConcurrent: Number(process.env.XAI_MAX_CONCURRENCY ?? 3),
        // Default OFF: without both the confirm flag and a key, a mock runs and
        // no money is spent.
        live: envFlagTrue('XAI_LIVE_CONFIRM') && envNonEmpty('XAI_API_KEY'),
      },
      drive: {
        /**
         * TRIMMED, unlike the first cut of this block. A refresh token or a
         * folder id pasted out of a browser can carry a trailing newline, and
         * an untrimmed folder id travels into a Drive `parents` array where it
         * produces a 404 that looks exactly like a missing folder.
         */
        clientId: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim() || null,
        clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim() || null,
        refreshToken: (process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '').trim() || null,
        folderId: (process.env.GOOGLE_DRIVE_FOLDER_ID ?? '').trim() || null,
        timeoutMs: Number(process.env.GOOGLE_DRIVE_TIMEOUT_MS ?? 60_000),
        /**
         * THE THREE CREDENTIALS, AND NO DESTINATION. A folder id is no longer
         * required — and requiring it was the bug: the only folder this scope
         * can write to is one the app creates for itself, whose id does not
         * exist until it does.
         */
        /**
         * THE CLIENT PAIR ONLY. The refresh token is no longer required here
         * because it is no longer an environment concern: an operator supplies
         * it by connecting Drive, and the env value survives purely as a
         * fallback for a server that has not been connected yet.
         */
        live: envNonEmpty('GOOGLE_OAUTH_CLIENT_ID') && envNonEmpty('GOOGLE_OAUTH_CLIENT_SECRET'),
        tokenUrl: process.env.GOOGLE_DRIVE_TOKEN_URL || null,
        uploadUrl: process.env.GOOGLE_DRIVE_UPLOAD_URL || null,
        filesUrl: process.env.GOOGLE_DRIVE_FILES_URL || null,
        /** Where Google sends the operator back. Must match the Console exactly. */
        redirectUri: (process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim() || null,
        /** AES-256-GCM key, base64, 32 bytes. Without it, connecting is refused. */
        tokenEncryptionKey: (process.env.PROMPT_GENERATION_TOKEN_KEY ?? '').trim() || null,
        userinfoUrl: process.env.GOOGLE_OAUTH_USERINFO_URL || null,
        authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || null,
      },
      spoolDir:
        process.env.PROMPT_GENERATION_SPOOL_DIR ??
        `${process.env.MEDIA_STORAGE_DIR ?? 'var/media'}/prompt-generation`,
    },
  };
}
