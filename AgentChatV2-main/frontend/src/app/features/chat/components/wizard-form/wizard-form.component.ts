import { Component, Input, Output, EventEmitter, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';

/** A field parsed from an agent's response asking for user input. */
export interface ParsedInputField {
  /** Original bold label from the agent message (e.g. "Company Name") */
  label: string;
  /** Hint text extracted from parenthetical (e.g. "e.g., Contoso Ltd.") */
  hint: string;
  /** Inferred input type */
  type: 'text' | 'textarea' | 'date' | 'email' | 'url' | 'number';
}

/**
 * Parses an assistant message looking for a bullet list of bold field names,
 * which is the typical pattern when an agent asks the user for structured input.
 *
 * Detects patterns like:
 *   - **Field Name** (description or example)
 *   - **Field Name**: description
 *   * **Field Name** — description
 *
 * Returns an array of ParsedInputField if the message looks like an input
 * request, or an empty array if it doesn't match.
 */
export function parseInputFields(markdownContent: string): ParsedInputField[] {
  if (!markdownContent) return [];

  const lines = markdownContent.split('\n');

  // Matches bullet or numbered lists with bold field names:
  //   - **Label** rest  /  * **Label** rest  /  • **Label** rest
  //   1. **Label** rest  /  1) **Label** rest
  const fieldPattern = /^\s*(?:[-*\u2022]|\d+[.)]\s*)\s+\*\*(.+?)\*\*\s*(.*)/;

  const candidates: ParsedInputField[] = [];
  let filledCount = 0;

  for (const line of lines) {
    const match = line.match(fieldPattern);
    if (!match) continue;

    const label = match[1].trim().replace(/:$/, ''); // strip trailing colon if inside bold
    const rest = match[2].trim();

    // Extract hint from parenthetical or after colon/dash
    let hint = '';
    const parenMatch = rest.match(/^\((.+?)\)/);
    if (parenMatch) {
      hint = parenMatch[1];
    } else if (rest.startsWith(':') || rest.startsWith('\u2014') || rest.startsWith('-')) {
      hint = rest.replace(/^[:\u2014-]\s*/, '').trim();
    } else {
      hint = rest;
    }

    // Track whether this field already has a concrete value filled in.
    // Handles both "**Label**: Value" (colon outside bold) and "**Label:** Value" (colon inside bold)
    const colonValue = rest.match(/^:\s*(.+)/);
    const rawLabel = match[1].trim();
    const colonInsideBold = rawLabel.endsWith(':');
    if (colonValue) {
      const val = colonValue[1].trim();
      const looksLikeHint = /^(e\.g\.|for example|such as|your |enter |specify |provide |the )/i.test(val);
      if (val && !looksLikeHint) filledCount++;
    } else if (colonInsideBold && rest) {
      // Colon was inside bold: **Label:** Value — rest IS the value
      const looksLikeHint = /^(e\.g\.|for example|such as|your |enter |specify |provide |the )/i.test(rest);
      if (!looksLikeHint) filledCount++;
    }

    const type = inferFieldType(label, hint);
    candidates.push({ label, hint, type });
  }

  // Only return fields if we found at least 2 bullet-bold items —
  // a single one is likely not an input request
  if (candidates.length < 2) return [];

  // If most items already have concrete values, this is a result summary,
  // not an input request (e.g. "Company Name: Mires Corp")
  if (filledCount > candidates.length * 0.5) return [];

  return candidates;
}

/** Infer a field input type from the label and hint text */
function inferFieldType(label: string, hint: string): ParsedInputField['type'] {
  const combined = (label + ' ' + hint).toLowerCase();

  if (/\bdate\b|when.*start|effective|deadline|due\b/.test(combined)) return 'date';
  if (/\be-?mail\b|contact.*email|email.*address/.test(combined)) return 'email';
  if (/\burl\b|\blink\b|\bwebsite\b|https?:/.test(combined)) return 'url';
  if (/\bnumber\b|\bcount\b|\bamount\b|\bquantity\b|\bbudget\b|\bsalary\b/.test(combined)) return 'number';
  if (/\bdescription\b|\bdetails\b|\bsummary\b|\bcontent\b|\bbody\b|\bnotes?\b|\breason\b|\bjustification\b|\bpurpose\b/.test(combined)) return 'textarea';

  return 'text';
}

@Component({
  selector: 'app-wizard-form',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="wizard-form">
      <div class="wizard-header">
        <span class="material-icons">edit_note</span>
        <span class="wizard-title">Fill in the details</span>
      </div>

      <div class="wizard-fields">
        @for (field of fields; track field.label; let i = $index) {
          <div class="form-field" [class.full-width]="field.type === 'textarea'">
            <label [for]="'wf-' + i">{{ field.label }}</label>

            @switch (field.type) {
              @case ('textarea') {
                <textarea
                  [id]="'wf-' + i"
                  class="field-input"
                  [(ngModel)]="values[i]"
                  [placeholder]="field.hint"
                  rows="3"
                ></textarea>
              }
              @case ('date') {
                <input
                  [id]="'wf-' + i"
                  type="date"
                  class="field-input"
                  [(ngModel)]="values[i]"
                />
              }
              @case ('email') {
                <input
                  [id]="'wf-' + i"
                  type="email"
                  class="field-input"
                  [(ngModel)]="values[i]"
                  [placeholder]="field.hint"
                />
              }
              @case ('url') {
                <input
                  [id]="'wf-' + i"
                  type="url"
                  class="field-input"
                  [(ngModel)]="values[i]"
                  [placeholder]="field.hint"
                />
              }
              @case ('number') {
                <input
                  [id]="'wf-' + i"
                  type="number"
                  class="field-input"
                  [(ngModel)]="values[i]"
                  [placeholder]="field.hint"
                />
              }
              @default {
                <input
                  [id]="'wf-' + i"
                  type="text"
                  class="field-input"
                  [(ngModel)]="values[i]"
                  [placeholder]="field.hint"
                />
              }
            }
          </div>
        }
      </div>

      <div class="wizard-footer">
        <button
          class="btn btn-primary submit-btn"
          (click)="onSubmit()"
          [disabled]="!hasAnyValue() || disabled"
          aria-label="Submit form"
        >
          <span class="material-icons">arrow_upward</span>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .wizard-form {
      margin-top: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      overflow: hidden;
      background-color: var(--bg-secondary);
    }

    .wizard-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background-color: var(--bg-tertiary);
      border-bottom: 1px solid var(--border-color);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);

      .material-icons {
        font-size: 18px;
        color: var(--primary);
      }
    }

    .wizard-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      padding: 16px;
    }

    .form-field {
      display: flex;
      flex-direction: column;
      gap: 4px;

      &.full-width {
        grid-column: 1 / -1;
      }

      label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .field-input {
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      transition: border-color 0.15s ease;

      &:focus {
        outline: none;
        border-color: var(--primary);
      }

      &::placeholder {
        color: var(--text-muted);
        font-style: italic;
        font-size: 12px;
      }
    }

    textarea.field-input {
      resize: vertical;
      min-height: 60px;
    }

    .wizard-footer {
      display: flex;
      justify-content: flex-end;
      padding: 10px 16px;
      border-top: 1px solid var(--border-color);
    }

    .submit-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      padding: 0;
      border-radius: 999px;
      background: linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%);
      border: 1px solid rgba(37, 99, 235, 0.35);
      box-shadow: 0 10px 24px rgba(29, 78, 216, 0.18);
      transition:
        transform 0.18s ease,
        box-shadow 0.18s ease,
        background 0.18s ease,
        border-color 0.18s ease;

      .material-icons {
        font-size: 18px;
        color: #fff;
        transform: translateY(-1px);
        transition: transform 0.18s ease;
      }

      &:hover:not(:disabled) {
        transform: translateY(-1px);
        background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%);
        border-color: rgba(59, 130, 246, 0.55);
        box-shadow: 0 14px 30px rgba(37, 99, 235, 0.28);

        .material-icons {
          transform: translateY(-2px);
        }
      }

      &:active:not(:disabled) {
        transform: translateY(0);
        box-shadow: 0 8px 18px rgba(37, 99, 235, 0.22);
      }

      &:disabled {
        background: var(--bg-hover);
        border-color: var(--border-color);
        box-shadow: none;

        .material-icons {
          color: var(--text-muted);
          transform: none;
        }
      }
    }
  `]
})
export class WizardFormComponent implements OnChanges {
  @Input() fields: ParsedInputField[] = [];
  @Input() disabled = false;
  @Output() formSubmit = new EventEmitter<string>();

  values: string[] = [];

  ngOnChanges(): void {
    this.values = this.fields.map(() => '');
  }

  hasAnyValue(): boolean {
    return this.values.some(v => v?.trim());
  }

  onSubmit(): void {
    if (!this.hasAnyValue()) return;

    const lines: string[] = [];
    for (let i = 0; i < this.fields.length; i++) {
      const value = this.values[i]?.trim() || '';
      if (!value) continue;
      lines.push(`**${this.fields[i].label}**: ${value}`);
    }

    this.formSubmit.emit(lines.join('\n'));
  }
}
