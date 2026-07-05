import type { InvoiceLineInput } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';
import { color, font } from '../theme.ts';
import { Button } from './ui/Button.tsx';
import { Input } from './ui/Input.tsx';

// Draft line state kept as strings while editing (so an empty/partial number
// input doesn't fight the user), parsed to numbers only on submit. `id` is a
// stable client-only key, unrelated to the server's line id.
export interface LineDraft {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

export function emptyLineDraft(): LineDraft {
  return { id: crypto.randomUUID(), description: '', quantity: '1', unitPrice: '' };
}

export function lineDraftsFromInvoiceLines(
  lines: Array<{ description: string | null; quantity: string; unitPrice: string }>,
): LineDraft[] {
  if (lines.length === 0) return [emptyLineDraft()];
  return lines.map((line) => ({
    id: crypto.randomUUID(),
    description: line.description ?? '',
    quantity: line.quantity,
    unitPrice: line.unitPrice,
  }));
}

export type ParsedLineDrafts =
  | { ok: true; lines: InvoiceLineInput[] }
  | { ok: false; error: string };

// Mirrors the server's own validation (quantity > 0, unitPrice >= 0) so the
// user sees the problem inline instead of round-tripping to a 400 - the
// server still re-validates authoritatively.
export function parseLineDrafts(lines: LineDraft[]): ParsedLineDrafts {
  const parsed: InvoiceLineInput[] = [];
  for (const [index, line] of lines.entries()) {
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, error: `Line ${index + 1}: quantity must be greater than 0.` };
    }
    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return { ok: false, error: `Line ${index + 1}: unit price cannot be negative.` };
    }
    parsed.push({ description: line.description.trim() || undefined, quantity, unitPrice });
  }
  return { ok: true, lines: parsed };
}

export function computeDraftTotal(lines: LineDraft[]): number {
  return lines.reduce((sum, line) => {
    const qty = Number(line.quantity);
    const price = Number(line.unitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return sum;
    return sum + qty * price;
  }, 0);
}

export interface InvoiceLinesEditorProps {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
}

export function InvoiceLinesEditor({ lines, onChange }: InvoiceLinesEditorProps) {
  function updateLine(index: number, patch: Partial<LineDraft>) {
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function addLine() {
    onChange([...lines, emptyLineDraft()]);
  }

  function removeLine(index: number) {
    if (lines.length > 1) onChange(lines.filter((_, i) => i !== index));
  }

  // Grid columns shared by the header row and each line row so they align:
  // description (flex) / qty / unit price / amount / remove.
  const gridColumns = '1fr 92px 118px 108px 34px';
  const headerCell = (text: string, align: 'left' | 'right' = 'left') => (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        color: color.textFaint,
        textAlign: align,
      }}
    >
      {text}
    </div>
  );

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridColumns,
          gap: 10,
          alignItems: 'center',
          padding: '0 2px 8px',
        }}
      >
        {headerCell('Description')}
        {headerCell('Qty', 'right')}
        {headerCell('Unit price', 'right')}
        {headerCell('Amount', 'right')}
        <div />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((line, index) => {
          const qty = Number(line.quantity);
          const price = Number(line.unitPrice);
          const amount = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
          return (
            <div
              key={line.id}
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: 10,
                alignItems: 'center',
              }}
            >
              <Input
                aria-label={`Line ${index + 1} description`}
                type="text"
                placeholder="Description"
                value={line.description}
                onChange={(event) => updateLine(index, { description: event.target.value })}
              />
              <Input
                aria-label={`Line ${index + 1} quantity`}
                type="number"
                step="0.01"
                mono
                value={line.quantity}
                onChange={(event) => updateLine(index, { quantity: event.target.value })}
              />
              <Input
                aria-label={`Line ${index + 1} unit price`}
                type="number"
                step="0.01"
                mono
                value={line.unitPrice}
                onChange={(event) => updateLine(index, { unitPrice: event.target.value })}
              />
              <div
                style={{
                  fontFamily: font.mono,
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                  color: color.text2,
                }}
              >
                {formatMoney(amount)}
              </div>
              <Button
                variant="ghost"
                aria-label={`Remove line ${index + 1}`}
                onClick={() => removeLine(index)}
                disabled={lines.length === 1}
                height={34}
                style={{ padding: '0 8px', color: color.textFaint, fontSize: 18, lineHeight: 1 }}
              >
                ×
              </Button>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <Button variant="secondary" onClick={addLine} height={34}>
          + Add line
        </Button>
      </div>
    </div>
  );
}
