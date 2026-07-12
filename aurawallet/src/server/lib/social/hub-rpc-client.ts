/**
 * Typed RPC client for hub communication.
 *
 * Replaces per-file fetch() calls with a single `call(method, params)`.
 * Envelope: { method, params } → { ok: true, result } | { ok: false, error, detail }
 */

export class HubRpcError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly statusCode: number;

  constructor(code: string, detail: string, statusCode = 400) {
    super(`${code}: ${detail}`);
    this.name = 'HubRpcError';
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

export interface HubRpcCallOptions {
  /** Override default timeout (ms). Default: 15_000. */
  timeoutMs?: number;
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
  /** Override bearer token for this call only. */
  bearerToken?: string;
}

export interface HubRpcClientOptions {
  /** Optional bearer token sent as Authorization header. */
  bearerToken?: string;
}

export class HubRpcClient {
  private bearerToken?: string;

  constructor(private readonly hubUrl: string, opts?: HubRpcClientOptions) {
    this.bearerToken = opts?.bearerToken;
  }

  setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  /**
   * Call an RPC method on the hub. Returns the `result` on success.
   * Throws `HubRpcError` on RPC-level errors, or a plain `Error` on network failure.
   */
  async call<R = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts?: HubRpcCallOptions,
  ): Promise<R> {
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
    const bearerToken = opts?.bearerToken ?? this.bearerToken;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bearerToken) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }

    const res = await fetch(`${this.hubUrl}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params }),
      signal,
    });

    const json = (await res.json()) as Record<string, unknown>;

    if (!json.ok) {
      throw new HubRpcError(
        (json.error as string) ?? 'unknown_error',
        (json.detail as string) ?? 'Hub returned an error',
        res.status,
      );
    }

    return json.result as R;
  }

  /**
   * Like `call()` but returns `null` instead of throwing on any error.
   * Useful for cron jobs and graceful degradation paths.
   */
  async tryCall<R = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts?: HubRpcCallOptions,
  ): Promise<R | null> {
    try {
      return await this.call<R>(method, params, opts);
    } catch {
      return null;
    }
  }
}
