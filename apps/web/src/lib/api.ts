import type { ApiErrorBody, ErrorCode } from '@kode/shared';

/**
 * The HTTP client.
 *
 * Two behaviours here carry the weight of the auth design:
 *
 *   · The access token lives in a module variable, never in localStorage. A
 *     token in any persistent store is readable by injected script; in memory
 *     it dies with the tab, and the httpOnly refresh cookie is what survives a
 *     reload instead.
 *
 *   · A 401 triggers exactly **one** refresh, shared by every request that hit
 *     the wall at the same moment. Without the shared promise, a dashboard that
 *     fires six queries on mount would fire six refreshes — and because refresh
 *     tokens rotate and reuse revokes the whole family (§B12.3), five of them
 *     would present an already-rotated token and end the session. That failure
 *     mode looks exactly like a security incident and is entirely self-inflicted.
 */

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

type Listener = (event: 'signed-out' | 'refreshed') => void;
const listeners = new Set<Listener>();

export function onAuthEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: 'signed-out' | 'refreshed'): void {
  for (const listener of listeners) listener(event);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** A failed request, carrying the server's structured error for the UI to read. */
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    status: number,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }

  /** True when the server is asking the user to confirm rather than refusing. */
  get needsConfirmation(): boolean {
    return this.details?.['requiresConfirmation'] === true;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Set internally to stop a refresh loop. */
  isRetry?: boolean;
  /** Multipart uploads bypass JSON encoding. */
  formData?: FormData;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (options.body !== undefined && !options.formData) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? (options.body || options.formData ? 'POST' : 'GET'),
      headers,
      // The refresh cookie must travel; everything else is bearer-token based.
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.formData
        ? { body: options.formData }
        : options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
    });
  } catch (error) {
    // A genuine transport failure — offline, DNS, the server down. Distinguished
    // from an HTTP error because the UI's response differs: "you appear to be
    // offline" rather than "that was rejected".
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }

  if (response.status === 401 && !options.isRetry && path !== '/auth/refresh') {
    const refreshed = await refreshOnce();
    if (refreshed) return request<T>(path, { ...options, isRetry: true });
    emit('signed-out');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiError(
      body?.error.code ?? 'INTERNAL_ERROR',
      body?.error.message ?? `Request failed with status ${response.status}.`,
      response.status,
      body?.error.details,
      body?.error.requestId ?? response.headers.get('X-Request-Id') ?? undefined,
    );
  }

  return payload as T;
}

/**
 * Refreshes the session, collapsing concurrent callers onto one request.
 *
 * See the note at the top of this file: without collapsing, parallel refreshes
 * present rotated tokens and the family-revocation rule ends the session.
 */
async function refreshOnce(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { accessToken: string };
      accessToken = data.accessToken;
      emit('refreshed');
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all observe
      // the same result before a new attempt can begin.
      queueMicrotask(() => {
        refreshPromise = null;
      });
    }
  })();

  return refreshPromise;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'GET', ...(signal ? { signal } : {}) }),

  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body }) }),

  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', ...(body === undefined ? {} : { body }) }),

  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),

  upload: <T>(path: string, formData: FormData): Promise<T> =>
    request<T>(path, { method: 'POST', formData }),
};

/** Builds a query string, omitting empty values so URLs stay readable. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
