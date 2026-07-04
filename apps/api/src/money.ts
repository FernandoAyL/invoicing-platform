// Exact decimal <-> integer-cents conversion. `numeric(14,2)` columns come
// back from pg as strings; comparing/summing money by float arithmetic risks
// drift (0.1 + 0.2 !== 0.3), so every amount is converted to integer cents
// and compared/summed as integers instead.

const AMOUNT_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(value: string | number): number {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`invalid amount: ${value}`);
  }

  const trimmed = String(value).trim();
  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) {
    throw new RangeError(`invalid amount: ${value}`);
  }

  const [, sign, whole, frac = ''] = match;
  const paddedFrac = frac.padEnd(2, '0');
  const cents = Number(whole) * 100 + Number(paddedFrac);
  return sign === '-' ? -cents : cents;
}

export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`invalid cents: ${cents}`);
  }

  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}
