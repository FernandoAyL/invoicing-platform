// Nav-icon set traced from docs/design/clearbook/Clearbook.dc.html's sidebar
// (lines ~42-67). Kept local to the shell - these are the only place icons
// are used in Phase-1. All are decorative and always rendered next to a
// visible text label, so they're `aria-hidden` rather than titled.
import type { CSSProperties } from 'react';
import { color } from '../../theme.ts';

interface IconProps {
  style?: CSSProperties;
}

const COMMON = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
};

// `aria-hidden="true"` is written as a literal attribute (not folded into
// COMMON and spread) because biome's a11y lint checks the `<svg>` tag's own
// attributes statically and can't see through a spread.

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function InvoicesIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="9" y1="12" x2="15" y2="12" />
      <line x1="9" y1="16" x2="13" y2="16" />
    </svg>
  );
}

export function CustomersIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M17 14c2.4 0 4 1.6 4 4" />
    </svg>
  );
}

export function IntegrationsIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <circle cx="7" cy="12" r="3" />
      <circle cx="17" cy="12" r="3" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

export function ReportsIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="7" />
      <line x1="18" y1="20" x2="18" y2="10" />
    </svg>
  );
}

export function VendorBillsIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color.textFaintAlt}
      strokeWidth={2}
      aria-hidden="true"
      {...props}
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

export function ConflictsIcon(props: IconProps) {
  return (
    <svg {...COMMON} aria-hidden="true" {...props}>
      <path d="M12 3.5 21 19.5H3z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <circle cx="12" cy="16.7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      aria-hidden="true"
      {...props}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
