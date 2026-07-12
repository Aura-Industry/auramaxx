/**
 * Shared error helpers used across routes and lib modules.
 */

/**
 * Extract a human-readable message from an unknown catch value.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * An error with an HTTP status code, thrown by validation helpers
 * so callers can respond with the correct status.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
