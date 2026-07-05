// Typed mirror of the Clearbook design tokens defined as CSS custom
// properties in `src/styles/global.css`. Components read from here (not
// `var(--...)`) so values are type-checked and autocompletable in inline
// `style={{ }}` objects, which is how this app styles components (see
// `docs/design-system.md`). Keep the two files' hex values in sync by hand -
// there is no build step generating one from the other.
//
// Where the design system lists more than one hex per token (surfaces used
// in slightly different shades across the comp), the first value is taken
// as the canonical token here; call sites that need a comp-exact secondary
// shade (e.g. the customer-row avatar chip) hardcode it locally with a
// comment pointing back to the comp.

export const color = {
  brand: '#1f7a4d',
  brandStrong: '#15733f',
  brandTint: '#e7f0ea',
  brandWash: '#f4faf6',
  canvas: '#eef1ee',
  surface: '#ffffff',
  surfaceMuted: '#f7f9f7',
  border: '#e4e8e4',
  borderSoft: '#eef1ee',
  borderInput: '#d7ddd8',
  text: '#14231c',
  text2: '#3a4b42',
  textMuted: '#6b7a71',
  textFaint: '#8a978f',
  // The design system's "text-faint" row lists two hexes (#8a978f / #9aa79f) -
  // this is the second, slightly lighter one, used for the sidebar's
  // MENU/COMING SOON group labels and the topbar search icon.
  textFaintAlt: '#9aa79f',
  textDisabled: '#b3bdb5',
  // Status families - see docs/design-system.md "Status badge" tables.
  statusSuccessBg: '#e7f3ec',
  statusSuccessText: '#15733f',
  statusWarnBg: '#fbf1dc',
  statusWarnText: '#b7791f',
  statusDangerBg: '#fdf1ef',
  statusDangerBgStrong: '#fbe9e7',
  statusDangerText: '#c0392b',
  statusDangerTextStrong: '#b23a2c',
  // Border for the danger-tinted callout card (comp's "needs attention" box).
  statusDangerBorder: '#f0cfc9',
} as const;

export const font = {
  sans: '"IBM Plex Sans", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
} as const;

export const radius = {
  card: 13,
  control: 9,
  chip: 7,
  pill: 999,
} as const;

export const shadow = {
  card: '0 1px 2px rgba(20,35,28,.04)',
  elevated: '0 6px 20px rgba(20,35,28,.1)',
  drawer: '-8px 0 30px rgba(20,35,28,.14)',
  buttonPrimary: '0 2px 5px rgba(31,122,77,.28)',
} as const;

export const spacing = {
  sidebarWidth: 238,
  topbarHeight: 60,
  pageMaxWidth: 1180,
} as const;

export const theme = { color, font, radius, shadow, spacing } as const;
