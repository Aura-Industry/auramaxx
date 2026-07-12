import { getErrorMessage } from '../../lib/error';
import { buildClaimHeaders, buildPollUrl } from '../../lib/approval-flow';

export type AuthDecisionStatus = 'pending' | 'approved' | 'rejected';

export interface AuthDecisionResponse {
  success?: boolean;
  status?: AuthDecisionStatus;
  encryptedToken?: string;
  error?: string;
  [key: string]: unknown;
}

export interface AuthDecisionFetchResult {
  httpStatus: number;
  payload: AuthDecisionResponse;
}

export interface AuthDecisionPollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onPending?: (info: { attempt: number; elapsedMs: number }) => void;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableClientStatus(httpStatus: number): boolean {
  return httpStatus === 404 || httpStatus === 408 || httpStatus === 425 || httpStatus === 429;
}

function formatPollingError(prefix: string, httpStatus: number, payload: AuthDecisionResponse): string {
  const detail = typeof payload.error === 'string' ? payload.error.trim() : '';
  return detail ? `${prefix} (HTTP ${httpStatus}): ${detail}` : `${prefix} (HTTP ${httpStatus}).`;
}

export async function fetchAuthDecisionOnce(
  baseUrl: string,
  requestId: string,
  secret: string,
): Promise<AuthDecisionFetchResult> {
  const res = await fetch(
    buildPollUrl(baseUrl, requestId, secret),
    {
      signal: AbortSignal.timeout(10_000),
      headers: buildClaimHeaders(secret),
    },
  );

  const payload = await res.json().catch(() => ({})) as AuthDecisionResponse;
  return { httpStatus: res.status, payload };
}

export async function waitForAuthDecision(
  baseUrl: string,
  requestId: string,
  secret: string,
  options: AuthDecisionPollOptions = {},
): Promise<{ response: AuthDecisionResponse; attempts: number; elapsedMs: number }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (options.signal?.aborted) {
      throw new Error('Polling aborted');
    }

    attempts += 1;
    let result: AuthDecisionFetchResult;
    try {
      result = await fetchAuthDecisionOnce(baseUrl, requestId, secret);
    } catch (error) {
      const message = getErrorMessage(error);
      throw new Error(`Auth polling request failed: ${message}`);
    }

    const { httpStatus, payload } = result;

    if (httpStatus === 200) {
      if (payload.success !== true) {
        throw new Error(formatPollingError(
          'Auth polling returned an unsuccessful response',
          httpStatus,
          payload,
        ));
      }

      if (payload.status === 'approved' || payload.status === 'rejected') {
        return {
          response: payload,
          attempts,
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (payload.status === 'pending') {
        options.onPending?.({ attempt: attempts, elapsedMs: Date.now() - startedAt });
        await sleep(intervalMs);
        continue;
      }

      const rawStatus = typeof payload.status === 'string' ? payload.status : String(payload.status ?? 'missing');
      throw new Error(formatPollingError(
        `Auth polling returned unexpected status "${rawStatus}"`,
        httpStatus,
        payload,
      ));
    }

    if (httpStatus === 410) {
      throw new Error('Token already claimed or expired (HTTP 410). Create a new auth request.');
    }

    if (httpStatus === 403) {
      throw new Error(payload.error || 'Invalid secret for auth polling (HTTP 403). Confirm reqId/secret and retry.');
    }

    if (httpStatus >= 500) {
      throw new Error(formatPollingError(
        'Auth polling failed due to a server error',
        httpStatus,
        payload,
      ));
    }

    if (httpStatus >= 400 && httpStatus < 500 && !isRetryableClientStatus(httpStatus)) {
      throw new Error(formatPollingError(
        'Auth polling failed with a non-retryable client error',
        httpStatus,
        payload,
      ));
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for approval after ${Math.round(timeoutMs / 1000)}s.`);
}
