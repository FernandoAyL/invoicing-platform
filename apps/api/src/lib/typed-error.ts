// Factory for the single-purpose `class XError extends Error { constructor(message) { super(message); this.name = 'XError'; } }`
// shape repeated across invoices/service.ts, payments/service.ts, qbo/errors.ts, and ledger/posting.ts.
// Each call produces its own distinct class (so `instanceof` stays scoped to the module that created it) —
// this only removes the boilerplate, not the type distinction between error kinds.
//
// Errors that carry extra fields (e.g. `QboApiError.retryable`, `UnbalancedError.debitCents`) don't fit this
// shape and are written by hand instead.

export function createErrorClass(name: string): new (message: string) => Error;
export function createErrorClass(
  name: string,
  defaultMessage: string,
): new (
  message?: string,
) => Error;
export function createErrorClass(name: string, defaultMessage?: string) {
  return class extends Error {
    constructor(message: string = defaultMessage as string) {
      super(message);
      this.name = name;
    }
  };
}
