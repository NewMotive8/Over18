import type {
  ApiError,
  AuthCredentials,
  AuthUser,
  ChatMessage,
  CharacterVisualIdentityResponse,
  ConversationSummary,
  HealthResponse,
  PublicCharacter,
  SendMessageResult,
} from '@over18/shared';

/**
 * Single entry point for talking to the Over18 REST API.
 * The frontend never accesses the database directly — everything goes through
 * this client. All requests are credentialed so the HttpOnly session cookie
 * flows automatically; no tokens are ever stored in localStorage.
 */
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Error carrying the API's error envelope plus HTTP status. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export const charactersApi = {
  list(): Promise<PublicCharacter[]> {
    return request<PublicCharacter[]>('/api/characters');
  },
  get(characterId: string): Promise<PublicCharacter> {
    return request<PublicCharacter>(`/api/characters/${encodeURIComponent(characterId)}`);
  },
  /** US-16B: public visual identity + approved canonical gallery for a character. */
  visualIdentity(characterId: string): Promise<CharacterVisualIdentityResponse> {
    return request<CharacterVisualIdentityResponse>(
      `/api/characters/${encodeURIComponent(characterId)}/visual-identity`,
    );
  },
};

export const conversationsApi = {
  /** Creates the conversation with a character, or reopens the existing one. */
  start(characterId: string): Promise<ConversationSummary> {
    return request<ConversationSummary>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    });
  },
  get(conversationId: string): Promise<ConversationSummary> {
    return request<ConversationSummary>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
    );
  },
};

export const messagesApi = {
  list(conversationId: string): Promise<ChatMessage[]> {
    return request<ChatMessage[]>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  },
  /**
   * `requestMedia` is the explicit, deliberate trigger for a character to send
   * media. It is OMITTED for ordinary sends — including every send the chat UI
   * makes today — so normal conversation is never altered. The server ignores
   * it unless CHAT_MEDIA_ENABLED is on, and the server, never the model,
   * decides which asset is sent.
   */
  send(
    conversationId: string,
    content: string,
    requestMedia?: 'image' | 'video',
  ): Promise<SendMessageResult> {
    return request<SendMessageResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(requestMedia ? { content, requestMedia } : { content }),
      },
    );
  },
};

export const authApi = {
  register(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  login(credentials: AuthCredentials): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  me(): Promise<AuthUser> {
    return request<AuthUser>('/api/auth/me');
  },
};

/** US-106 — admin content review. Uses the same session-cookie request helper. */
export interface ReviewAssetView {
  assetId: string;
  characterId: string;
  characterName: string;
  mediaType: 'image' | 'video';
  status: 'generated' | 'under_review' | 'approved' | 'rejected';
  contentRating: 'sfw' | 'explicit';
  /** The configured content requirement this item is filed under, if any. */
  requirementKey: string | null;
  isPrimary: boolean;
  storageKey: string | null;
  createdAt: string;
  approvedAt: string | null;
  provenance: {
    jobId: string | null;
    provider: string | null;
    model: string | null;
    generatedAt: string | null;
  };
}

export interface CharacterReviewSummary {
  characterId: string;
  characterName: string;
  pendingCount: number;
}

export interface LibraryAssetView extends ReviewAssetView {
  recencyBasis: 'approved' | 'added';
  recentAt: string;
}

export const contentLibraryApi = {
  list: (params: { characterId?: string; mediaType?: 'image' | 'video'; search?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.characterId) q.set('characterId', params.characterId);
    if (params.mediaType) q.set('mediaType', params.mediaType);
    if (params.search) q.set('search', params.search);
    const suffix = q.toString() ? `?${q}` : '';
    return request<{ recent: LibraryAssetView[]; assets: LibraryAssetView[]; filtered: boolean }>(
      `/admin/content/library${suffix}`,
    );
  },
  /**
   * Manual upload of one existing image/video file. Sent as multipart/form-data,
   * so the Content-Type header is left to the browser (it must supply the
   * boundary) — that is why this cannot use the JSON `request` helper.
   */
  upload: async (file: File, characterId: string): Promise<LibraryAssetView> => {
    const form = new FormData();
    form.append('characterId', characterId);
    form.append('file', file);
    const res = await fetch(`${API_URL}/admin/content/uploads`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      let code = 'request_failed';
      let message = `Upload failed (${res.status}).`;
      try {
        const body = (await res.json()) as Partial<ApiError>;
        if (body.error) code = body.error;
        if (body.message) message = body.message;
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      throw new ApiRequestError(res.status, code, message);
    }
    return (await res.json()) as LibraryAssetView;
  },
  /** Permanently deletes a Library asset and its stored file. */
  remove: (assetId: string) =>
    request<{ assetId: string; fileRemoved: boolean; fileWasMissing: boolean }>(
      `/admin/content/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),
};

/* ------------------------------------------------------------------ *
 * Configurable content requirements
 *
 * Every category and quantity below arrives from the server. Nothing in this
 * application declares what a character needs — that lives in configuration.
 * ------------------------------------------------------------------ */

export type MediaTypeName = 'image' | 'video';

export interface ContentRequirementView {
  id: string;
  key: string;
  label: string;
  mediaType: MediaTypeName;
  requiredQuantity: number;
  /** Advisory policy, never a filter on what counts. */
  contentRating: 'sfw' | 'explicit' | null;
  enabled: boolean;
  assignPrimaryReference: boolean;
  position: number;
}

export interface ContentRequirementRowView extends ContentRequirementView {
  /** How many items are filed under this key — why deleting may be refused. */
  assignedAssetCount: number;
}

export interface RequirementTotals {
  items: number;
  images: number;
  videos: number;
}

export interface CharacterProgressView {
  characterId: string;
  characterName: string;
  displayName: string;
  required: number;
  approved: number;
  pending: number;
  missing: number;
  complete: boolean;
}

export interface RequirementEntryView {
  key: string;
  label: string;
  mediaType: MediaTypeName;
  contentRating: 'sfw' | 'explicit' | null;
  /** The configured quantity — the board renders this many capacity slots. */
  required: number;
  approved: number;
  pending: number;
  remaining: number;
  surplus: number;
  satisfied: boolean;
  assets: ReviewAssetView[];
}

export type TriageReason = 'uncategorised' | 'unknown_requirement' | 'media_mismatch';

export interface TriageAssetView extends ReviewAssetView {
  reason: TriageReason;
}

export interface ReviewWorkspaceView {
  characters: CharacterProgressView[];
  requirements: ContentRequirementView[];
  inbox: { unassignedCount: number };
  selected: {
    character: { id: string; name: string; displayName: string; status: string };
    totals: { required: number; approved: number; pending: number; missing: number; complete: boolean };
    requirements: RequirementEntryView[];
    triage: TriageAssetView[];
  } | null;
}

export interface InboxItemView {
  inboxId: string;
  status: 'unassigned' | 'assigned' | 'discarded';
  mediaType: MediaTypeName;
  originalName: string | null;
  byteSize: number;
  fileUrl: string | null;
  assignedAssetId: string | null;
  createdAt: string;
}

export interface RequirementDraft {
  label: string;
  mediaType: MediaTypeName;
  requiredQuantity?: number;
  contentRating?: 'sfw' | 'explicit' | null;
  enabled?: boolean;
  assignPrimaryReference?: boolean;
  position?: number;
}

export const contentRequirementsApi = {
  list: () =>
    request<{ requirements: ContentRequirementRowView[]; totals: RequirementTotals }>(
      '/admin/settings/content-requirements',
    ),
  /** What the configuration means for real characters, right now. */
  impact: () =>
    request<{ characters: CharacterProgressView[] }>(
      '/admin/settings/content-requirements/impact',
    ),
  create: (draft: RequirementDraft) =>
    request<ContentRequirementView>('/admin/settings/content-requirements', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (id: string, patch: Partial<RequirementDraft>) =>
    request<ContentRequirementView>(
      `/admin/settings/content-requirements/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  remove: (id: string) =>
    request<void>(`/admin/settings/content-requirements/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

/* ------------------------------------------------------------------ *
 * App Categories (US-102.1)
 * ------------------------------------------------------------------ */

/**
 * A user-facing merchandising category.
 *
 * NOT a content requirement. Requirements describe what must be PRODUCED for a
 * character; these describe how already-approved content is ORGANISED in the
 * app. Separate endpoints, separate tables, no shared field.
 */
export interface AppCategoryView {
  id: string;
  /** Stable internal identity, fixed at creation. Renaming never changes it. */
  slug: string;
  name: string;
  tagline: string | null;
  enabled: boolean;
  position: number;
  /** Approved Library items merchandised here. Assignment arrives in US-102.2. */
  assignedAssetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppCategoryTotals {
  categories: number;
  enabled: number;
  assignedAssets: number;
}

export interface AppCategoryDraft {
  name: string;
  /** Omitted on create so the server derives it from the name. */
  slug?: string;
  tagline?: string | null;
  enabled?: boolean;
}

export const appCategoriesApi = {
  list: () =>
    request<{ categories: AppCategoryView[]; totals: AppCategoryTotals }>('/admin/app-categories'),
  create: (draft: AppCategoryDraft) =>
    request<AppCategoryView>('/admin/app-categories', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  /** `slug` is deliberately absent: the server refuses it, and so does this. */
  update: (id: string, patch: Partial<Omit<AppCategoryDraft, 'slug'>>) =>
    request<AppCategoryView>(`/admin/app-categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** Returns how many items became unassigned. Never deletes an asset. */
  remove: (id: string) =>
    request<{ deleted: true; releasedAssetCount: number }>(
      `/admin/app-categories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** Whole-list reorder. The server refuses anything but an exact permutation. */
  reorder: (orderedIds: string[]) =>
    request<{ categories: AppCategoryView[] }>('/admin/app-categories/order', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds }),
    }),
};

export const contentReviewApi = {
  summary: () =>
    request<{ characters: CharacterReviewSummary[] }>('/admin/content/review/summary'),
  /** The whole board in one request: rail, configuration, inbox count, slots. */
  workspace: (characterId?: string) =>
    request<ReviewWorkspaceView>(
      `/admin/content/review/workspace${characterId ? `?characterId=${encodeURIComponent(characterId)}` : ''}`,
    ),
  /** Files an item under a category, or clears it back to triage with null. */
  setRequirement: (assetId: string, requirementKey: string | null) =>
    request<ReviewAssetView>(`/admin/content/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ requirementKey }),
    }),
  inbox: () => request<{ items: InboxItemView[] }>('/admin/content/inbox'),
  /** Upload with NO character chosen. */
  uploadToInbox: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postMultipart<InboxItemView>('/admin/content/inbox', form, 'Upload failed');
  },
  /** Upload straight to a character (and optionally a category). Enters Review. */
  uploadForCharacter: (file: File, characterId: string, requirementKey?: string) => {
    const form = new FormData();
    form.append('characterId', characterId);
    if (requirementKey) form.append('requirementKey', requirementKey);
    form.append('file', file);
    return postMultipart<ReviewAssetView>('/admin/content/uploads', form, 'Upload failed');
  },
  assignInboxItem: (inboxId: string, body: { characterId: string; requirementKey?: string | null }) =>
    request<{ item: InboxItemView; asset: ReviewAssetView }>(
      `/admin/content/inbox/${encodeURIComponent(inboxId)}/assign`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discardInboxItem: (inboxId: string) =>
    request<InboxItemView>(`/admin/content/inbox/${encodeURIComponent(inboxId)}/discard`, {
      method: 'POST',
    }),
  queue: (params: { characterId?: string; mediaType?: 'image' | 'video' } = {}) => {
    const q = new URLSearchParams();
    if (params.characterId) q.set('characterId', params.characterId);
    if (params.mediaType) q.set('mediaType', params.mediaType);
    const suffix = q.toString() ? `?${q}` : '';
    return request<{ assets: ReviewAssetView[] }>(`/admin/content/review${suffix}`);
  },
  approve: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/approve`, { method: 'POST' }),
  reject: (assetId: string) =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}/reject`, { method: 'POST' }),
};

/* ------------------------------------------------------------------ *
 * US-101 — character, visual identity and primary reference management
 * ------------------------------------------------------------------ */

export interface AdminCharacterView {
  id: string;
  name: string;
  displayName: string;
  profileImage: string | null;
  shortBio: string;
  personality: string;
  interests: string[];
  conversationStyle: string;
  systemPrompt: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  /** False while any descriptive field is still blank (quick-created draft). */
  profileComplete: boolean;
  /** The still-blank fields, named, so the UI can be specific rather than vague. */
  missingProfileFields: string[];
}

export interface AdminCharacterListItem extends AdminCharacterView {
  activeIdentityVersion: number | null;
  identityVersionCount: number;
  primaryReferenceCount: number;
}

export interface VisualIdentityView {
  id: string;
  characterId: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  label: string | null;
  visualDna: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PrimaryReferenceView {
  assetId: string;
  characterId: string;
  visualIdentityId: string;
  kind: 'reference' | 'generated';
  status: string;
  isPrimary: boolean;
  position: number | null;
  contentRating: 'sfw' | 'explicit';
  mediaType: 'image' | 'video';
  fileUrl: string | null;
  createdAt: string;
}

export interface AdminCharacterDetail {
  character: AdminCharacterView;
  identities: VisualIdentityView[];
  activeIdentity: VisualIdentityView | null;
  primaryReferences: PrimaryReferenceView[];
}

/** Fields an operator may set. Exactly the columns the schema already has. */
export interface CharacterDraft {
  name: string;
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests: string[];
  status?: 'active' | 'inactive';
}

/** What Autofill proposes. A DRAFT — nothing is saved until the operator says so. */
export interface CharacterProfileDraft {
  displayName: string;
  shortBio: string;
  personality: string;
  conversationStyle: string;
  systemPrompt: string;
  interests: string[];
}

export interface QuickCreatedCharacter {
  character: AdminCharacterView;
  identity: VisualIdentityView;
  primaryReference: PrimaryReferenceView;
}

/**
 * Multipart POST. Separate from `request` because the browser must set
 * Content-Type itself (it alone knows the boundary), but the error handling is
 * identical, so it is shared rather than copied a third time.
 */
async function postMultipart<T>(path: string, form: FormData, failure: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    let code = 'request_failed';
    let message = `${failure} (${res.status}).`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const adminCharactersApi = {
  list: () => request<AdminCharacterListItem[]>('/admin/characters'),
  /**
   * Name + one image is enough to create a character: the server also creates
   * visual identity v1, activates it, and files the image as her primary
   * reference. The persona is filled in afterwards, by hand or by Autofill.
   */
  quickCreate: (input: { name: string; displayName?: string; file: File }) => {
    const form = new FormData();
    form.append('name', input.name);
    if (input.displayName) form.append('displayName', input.displayName);
    form.append('file', input.file);
    return postMultipart<QuickCreatedCharacter>(
      '/admin/characters/quick',
      form,
      "Couldn't create the character",
    );
  },
  /** What this character still needs, derived from the configuration. */
  requirements: (characterId: string) =>
    request<{
      totals: { required: number; approved: number; pending: number; missing: number; complete: boolean };
      requirements: RequirementEntryView[];
      triageCount: number;
    }>(`/admin/characters/${encodeURIComponent(characterId)}/requirements`),
  /** Proposes a persona. Returns a draft only — call `update` to save it. */
  autofill: (characterId: string) =>
    request<{ draft: CharacterProfileDraft }>(
      `/admin/characters/${encodeURIComponent(characterId)}/autofill`,
      { method: 'POST' },
    ),
  get: (id: string) => request<AdminCharacterDetail>(`/admin/characters/${encodeURIComponent(id)}`),
  create: (draft: CharacterDraft) =>
    request<AdminCharacterView>('/admin/characters', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),
  update: (id: string, patch: Partial<CharacterDraft>) =>
    request<AdminCharacterView>(`/admin/characters/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  listIdentities: (characterId: string) =>
    request<VisualIdentityView[]>(`/admin/characters/${encodeURIComponent(characterId)}/identities`),
  createIdentity: (
    characterId: string,
    body: { visualDna?: Record<string, unknown>; label?: string; fromIdentityId?: string },
  ) =>
    request<VisualIdentityView>(
      `/admin/characters/${encodeURIComponent(characterId)}/identities`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  activateIdentity: (identityId: string) =>
    request<VisualIdentityView>(`/admin/identities/${encodeURIComponent(identityId)}/activate`, {
      method: 'POST',
    }),
  listReferences: (identityId: string) =>
    request<PrimaryReferenceView[]>(
      `/admin/identities/${encodeURIComponent(identityId)}/references`,
    ),
  /** Multipart, so the browser must set the boundary — see postMultipart. */
  uploadReference: (identityId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postMultipart<PrimaryReferenceView>(
      `/admin/identities/${encodeURIComponent(identityId)}/references`,
      form,
      'Upload failed',
    );
  },
  removePrimary: (assetId: string) =>
    request<PrimaryReferenceView>(`/admin/references/${encodeURIComponent(assetId)}/primary`, {
      method: 'DELETE',
    }),
  makePrimary: (assetId: string) =>
    request<PrimaryReferenceView>(`/admin/references/${encodeURIComponent(assetId)}/primary`, {
      method: 'POST',
    }),
};
