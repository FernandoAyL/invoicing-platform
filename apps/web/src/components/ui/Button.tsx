import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { color, font, radius, shadow } from '../../theme.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Comp uses 38px in most places, 40-42px for a couple of primary CTAs. */
  height?: number;
  fullWidth?: boolean;
}

const BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  border: 'none',
  borderRadius: radius.control,
  padding: '0 15px',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: font.sans,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

// `background` is deliberately NOT set here - the `.ui-btn-<variant>` class
// (global.css) owns it (resting value + :hover value), since an inline
// style can never be overridden by a stylesheet :hover rule.
const VARIANT_STYLE: Record<ButtonVariant, CSSProperties> = {
  primary: {
    color: '#ffffff',
    boxShadow: shadow.buttonPrimary,
  },
  secondary: {
    border: `1px solid ${color.borderInput}`,
    color: color.text,
  },
  danger: {
    border: `1px solid ${color.borderInput}`,
    color: color.statusDangerTextStrong,
  },
  ghost: {
    color: color.brand,
  },
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn-primary',
  secondary: 'ui-btn-secondary',
  danger: 'ui-btn-danger',
  ghost: 'ui-btn-ghost',
};

// Primary/secondary/danger/ghost per docs/design-system.md "Button" spec.
// `ghost` (text-only, no border) is added beyond the literal 3-variant ask
// because the comp uses it constantly for low-emphasis actions (back links,
// "View all", icon-only row actions) that 10013-10017 will need - it costs
// nothing extra to expose here rather than have each screen hand-roll it.
export function Button({
  variant = 'secondary',
  height = 38,
  fullWidth = false,
  className,
  style,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`ui-btn ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      style={{
        ...BASE,
        ...VARIANT_STYLE[variant],
        height,
        width: fullWidth ? '100%' : undefined,
        ...style,
      }}
      {...rest}
    />
  );
}
