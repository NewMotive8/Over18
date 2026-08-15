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
  send(conversationId: string, content: string): Promise<SendMessageResult> {
    return request<SendMessageResult>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
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

export const contentReviewApi = {
  summary: () =>
    request<{ characters: CharacterReviewSummary[] }>('/admin/content/review/summary'),
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
  setRating: (assetId: string, contentRating: 'sfw' | 'explicit') =>
    request<ReviewAssetView>(`/admin/content/assets/${assetId}`, {
      method: 'PATCH',
      body: JSON.stringify({ contentRating }),
    }),
};
