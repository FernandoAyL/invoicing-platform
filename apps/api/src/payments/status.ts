// Pure derivation of invoice status from its total and total-applied-payments,
// both in integer cents. No I/O, no rounding — callers convert via toCents
// first so this never has to reason about string/float money.
export type PaymentDerivedStatus = 'open' | 'partially_paid' | 'paid';

export function deriveInvoiceStatus(totalCents: number, paidCents: number): PaymentDerivedStatus {
  if (paidCents <= 0) return 'open';
  if (paidCents >= totalCents) return 'paid';
  return 'partially_paid';
}
