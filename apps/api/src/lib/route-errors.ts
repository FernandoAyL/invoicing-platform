import type { FastifyReply } from 'fastify';

// biome-ignore lint/suspicious/noExplicitAny: matches any of the service's typed Error subclasses.
type ErrorClass = new (...args: any[]) => Error;

export interface ErrorMapping {
  errorClass: ErrorClass;
  status: number;
  code: string;
  /** Set false to omit `err.message` from the response body (e.g. a generic `not_found`). Defaults
   * to true. */
  withMessage?: boolean;
}

/**
 * Builds a route's `mapServiceError`: an ordered `instanceof` chain from `mappings`, each entry
 * mapping one of a service module's typed errors to an HTTP status + error code. Returns a function
 * that replies and returns `true` when handled, or `false` when the error is unmapped — the
 * caller's catch block should rethrow in that case, so an unexpected error still surfaces as a 500
 * rather than being silently swallowed.
 */
export function createServiceErrorMapper(mappings: ErrorMapping[]) {
  return function mapServiceError(err: unknown, reply: FastifyReply): boolean {
    for (const { errorClass, status, code, withMessage = true } of mappings) {
      if (err instanceof errorClass) {
        reply
          .code(status)
          .send(withMessage ? { error: code, message: err.message } : { error: code });
        return true;
      }
    }
    return false;
  };
}
