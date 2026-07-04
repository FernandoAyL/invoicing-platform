// Display-only formatting. The API is the money authority (fixed 2-decimal
// strings like "100.00"); this never re-rounds or re-derives a value, it
// only presents what the server already computed.
export function formatMoney(amount: string | number): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return typeof amount === 'string' ? amount : String(amount);
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
