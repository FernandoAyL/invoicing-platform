import { type SelectHTMLAttributes, useId } from 'react';
import { color, radius } from '../../theme.ts';
import { FieldError, FieldLabel } from './FieldLabel.tsx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  height?: number;
}

export function Select({ label, error, height = 38, id, style, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? (label ? generatedId : undefined);

  const select = (
    <select
      id={selectId}
      className="ui-field"
      style={{
        width: '100%',
        height,
        borderColor: error ? color.statusDangerTextStrong : undefined,
        borderRadius: radius.control - 1,
        padding: '0 9px',
        fontSize: 13,
        color: color.text,
        background: color.surface,
        ...style,
      }}
      {...rest}
    >
      {children}
    </select>
  );

  if (!label) return select;

  return (
    <div>
      <FieldLabel htmlFor={selectId}>{label}</FieldLabel>
      {select}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
