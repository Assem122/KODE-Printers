import type { ErrorCode } from '@kode/shared';
type Listener = (event: 'signed-out' | 'refreshed') => void;
export declare function onAuthEvent(listener: Listener): () => void;
export declare function setAccessToken(token: string | null): void;
export declare function getAccessToken(): string | null;
/** A failed request, carrying the server's structured error for the UI to read. */
export declare class ApiError extends Error {
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
  );
  /** True when the server is asking the user to confirm rather than refusing. */
  get needsConfirmation(): boolean;
}
export declare const api: {
  get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  put: <T>(path: string, body?: unknown) => Promise<T>;
  delete: <T>(path: string) => Promise<T>;
  upload: <T>(path: string, formData: FormData) => Promise<T>;
};
/** Builds a query string, omitting empty values so URLs stay readable. */
export declare function qs(
  params: Record<string, string | number | boolean | undefined | null>,
): string;
export {};
//# sourceMappingURL=api.d.ts.map
