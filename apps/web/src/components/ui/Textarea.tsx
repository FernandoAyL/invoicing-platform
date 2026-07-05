import { type TextareaHTMLAttributes, useId } from 'react';
import { color, radius } from '../../theme.ts';
import { FieldError, FieldLabel } from './FieldLabel.tsx';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, id, style, ...rest }: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? (label ? generatedId : undefined);

  const textarea = (
    <textarea
      id={textareaId}
      className="ui-field"
      style={{
        width: '100%',
        minHeight: 64,
        borderColor: error ? color.statusDangerTextStrong : undefined,
        borderRadius: radius.control - 1,
        padding: '9px 11px',
        fontSize: 13,
        fontFamily: 'inherit',
        color: color.text,
        background: color.surface,
        resize: 'vertical',
        ...style,
      }}
      {...rest}
    />
  );

  if (!label) return textarea;

  return (
    <div>
      <FieldLabel htmlFor={textareaId}>{label}</FieldLabel>
      {textarea}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
