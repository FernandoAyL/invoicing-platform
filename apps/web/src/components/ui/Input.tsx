import { type InputHTMLAttributes, useId } from 'react';
import { color, font, radius } from '../../theme.ts';
import { FieldError, FieldLabel } from './FieldLabel.tsx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /** Right-aligned IBM Plex Mono, for numeric/money fields per the comp. */
  mono?: boolean;
  height?: number;
}

// height 38-40, radius 8-9, border-input, per docs/design-system.md "Input".
// The `.ui-field` class (global.css) owns the resting/focus border-color -
// `borderColor` is only set inline for the `error` case (a per-instance
// override an inline value is the right tool for; it also means an errored
// field stays visibly red even while focused, which is intentional).
export function Input({ label, error, mono = false, height = 38, id, style, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? (label ? generatedId : undefined);

  const input = (
    <input
      id={inputId}
      className="ui-field"
      style={{
        width: '100%',
        height,
        borderColor: error ? color.statusDangerTextStrong : undefined,
        borderRadius: radius.control - 1,
        padding: mono ? '0 11px' : '0 12px',
        fontSize: mono ? 14 : 13,
        fontFamily: mono ? font.mono : font.sans,
        textAlign: mono ? 'right' : 'left',
        color: color.text,
        background: color.surface,
        ...style,
      }}
      {...rest}
    />
  );

  if (!label) return input;

  return (
    <div>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      {input}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
