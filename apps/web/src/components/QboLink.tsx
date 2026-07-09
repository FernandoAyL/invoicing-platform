import { color } from '../theme.ts';

// External deep link to a record in the QuickBooks Online web app. Opens in a new tab; the
// backend builds the href (`qboUrl`) so the frontend never needs to know the QBO environment/host.
export function QboLink({ href, label = 'View in QuickBooks' }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: color.brand, fontWeight: 600, fontSize: 12.5, textDecoration: 'none' }}
    >
      {label} ↗
    </a>
  );
}
