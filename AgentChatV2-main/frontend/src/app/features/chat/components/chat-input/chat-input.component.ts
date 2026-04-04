import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface TokenAgentBreakdown {
  name: string;
  input: number;
  output: number;
  total: number;
  percent: number;
}

interface TokenUsageSummary {
  label: string;
  input: number;
  output: number;
  total: number;
  llmCalls: number;
  agentBreakdown: TokenAgentBreakdown[];
}

@Component({
  selector: 'app-chat-input',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="chat-input-container">
      <div class="input-wrapper">
        <button 
          class="btn btn-icon attach-btn" 
          (click)="fileInput.click()"
          [disabled]="disabled"
          title="Attach file"
        >
          <span class="material-icons">attach_file</span>
        </button>
        
        <input
          type="file"
          #fileInput
          (change)="onFileSelected($event)"
          accept=".txt,.md,.pdf,.json,.csv"
          style="display: none"
        />
        
        <textarea
          #inputField
          class="input message-input"
          [(ngModel)]="message"
          (keydown)="onKeyDown($event)"
          [placeholder]="sessionId ? 'Send a message...' : 'Start a new conversation...'"
          [disabled]="disabled"
          rows="1"
        ></textarea>
        
        <button 
          class="btn btn-primary send-btn"
          (click)="sendMessage()"
          [disabled]="disabled || !message.trim()"
          title="Send message"
          aria-label="Send message"
        >
          <span class="material-icons">arrow_upward</span>
        </button>
      </div>
      
      <div class="input-footer">
        @if (tokenUsage) {
          <div class="token-usage-inline" (click)="$event.stopPropagation()">
            @if (tokenUsageOpen) {
              <div class="token-usage-popup token-usage-popup-upward">
                <div class="token-usage-popup-header">
                  <div>
                    <div class="token-popup-title">{{ tokenUsage.label }}</div>
                    <div class="token-popup-subtitle">LLM token usage for the current response</div>
                  </div>
                  <button class="token-popup-close" (click)="closeTokenUsagePopup()" aria-label="Close usage details">
                    <span class="material-icons">close</span>
                  </button>
                </div>

                <div class="token-total-row">
                  <span class="token-total-value">{{ formatCompactTokens(tokenUsage.total) }}</span>
                  <span class="token-total-label">total tokens</span>
                </div>

                <div class="token-meter-caption">Input/output share for this response</div>
                <div class="token-meter">
                  <div class="token-meter-input" [style.width.%]="getUsagePercent(tokenUsage.input, tokenUsage.total)"></div>
                  <div class="token-meter-output" [style.width.%]="getUsagePercent(tokenUsage.output, tokenUsage.total)"></div>
                </div>

                <div class="token-stat-grid">
                  <div class="token-stat-card">
                    <span class="token-stat-label">Input</span>
                    <span class="token-stat-value">{{ formatCompactTokens(tokenUsage.input) }}</span>
                  </div>
                  <div class="token-stat-card">
                    <span class="token-stat-label">Output</span>
                    <span class="token-stat-value">{{ formatCompactTokens(tokenUsage.output) }}</span>
                  </div>
                  <div class="token-stat-card">
                    <span class="token-stat-label">LLM Calls</span>
                    <span class="token-stat-value">{{ tokenUsage.llmCalls }}</span>
                  </div>
                </div>

                @if (tokenUsage.agentBreakdown.length > 0) {
                  <div class="token-breakdown">
                    <div class="token-breakdown-title">By agent</div>
                    @for (agent of tokenUsage.agentBreakdown; track agent.name) {
                      <div class="token-breakdown-row">
                        <div class="token-breakdown-header">
                          <span class="token-agent-name">{{ agent.name }}</span>
                          <span class="token-agent-total">{{ formatCompactTokens(agent.total) }}</span>
                        </div>
                        <div class="token-breakdown-bar">
                          <div class="token-breakdown-fill" [style.width.%]="agent.percent"></div>
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            }

            <button
              class="token-usage-pill"
              (click)="toggleTokenUsagePopup($event)"
              [attr.aria-expanded]="tokenUsageOpen"
              aria-label="Toggle response usage details"
              title="Response usage"
            >
              <span class="material-icons">donut_large</span>
              <span class="token-usage-pill-value">{{ formatCompactTokens(tokenUsage.total) }}</span>
            </button>
          </div>
        }

        <span class="char-count" [class.warning]="message.length > 3000">
          {{ message.length }} / 4000
        </span>
      </div>
    </div>
  `,
  styles: [`
    .chat-input-container {
      padding: var(--spacing-md);
      background-color: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }
    
    .input-wrapper {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-sm);
      background-color: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: var(--spacing-sm);
      transition: border-color var(--transition-fast);
      
      &:focus-within {
        border-color: var(--primary);
      }
    }
    
    .message-input {
      flex: 1;
      border: none;
      background: transparent;
      resize: none;
      max-height: 200px;
      min-height: 24px;
      padding: var(--spacing-sm);
      
      &:focus {
        border: none;
        outline: none;
      }
    }
    
    .attach-btn, .send-btn {
      flex-shrink: 0;
    }
    
    .send-btn {
      width: 42px;
      height: 42px;
      padding: 0;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
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
    
    .input-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      padding-top: var(--spacing-xs);
      position: relative;
    }
    
    .char-count {
      order: 2;
      font-size: 12px;
      color: var(--text-muted);
      
      &.warning {
        color: var(--warning);
      }
    }

    .token-usage-inline {
      order: 1;
      position: relative;
      display: flex;
      align-items: center;
    }

    .token-usage-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(59, 130, 246, 0.22);
      background: rgba(15, 23, 42, 0.84);
      backdrop-filter: blur(12px);
      color: #e2e8f0;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.2);
      cursor: pointer;
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;

      .material-icons {
        font-size: 15px;
        color: #60a5fa;
      }

      &:hover {
        transform: translateY(-1px);
        border-color: rgba(96, 165, 250, 0.45);
        box-shadow: 0 14px 28px rgba(15, 23, 42, 0.26);
      }
    }

    .token-usage-pill-value {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .token-usage-popup {
      width: 280px;
      padding: 14px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(15, 23, 42, 0.94);
      color: #e2e8f0;
      backdrop-filter: blur(16px);
      box-shadow: 0 22px 46px rgba(2, 6, 23, 0.38);
      z-index: 8;
    }

    .token-usage-popup-upward {
      position: absolute;
      right: 0;
      bottom: calc(100% + 10px);
    }

    .token-usage-popup-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }

    .token-popup-title {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
    }

    .token-popup-subtitle {
      margin-top: 2px;
      font-size: 11px;
      color: #94a3b8;
    }

    .token-popup-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: #94a3b8;
      cursor: pointer;

      .material-icons {
        font-size: 16px;
      }

      &:hover {
        background: rgba(148, 163, 184, 0.12);
        color: #e2e8f0;
      }
    }

    .token-total-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .token-total-value {
      font-size: 28px;
      font-weight: 800;
      line-height: 1;
      color: #f8fafc;
    }

    .token-total-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
    }

    .token-meter-caption {
      margin-bottom: 6px;
      font-size: 11px;
      color: #94a3b8;
    }

    .token-meter {
      display: flex;
      width: 100%;
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(51, 65, 85, 0.7);
      margin-bottom: 12px;
    }

    .token-meter-input {
      background: linear-gradient(90deg, #60a5fa 0%, #3b82f6 100%);
    }

    .token-meter-output {
      background: linear-gradient(90deg, #22c55e 0%, #10b981 100%);
    }

    .token-stat-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }

    .token-stat-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px;
      border-radius: 10px;
      background: rgba(30, 41, 59, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.08);
    }

    .token-stat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #94a3b8;
    }

    .token-stat-value {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
    }

    .token-breakdown {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .token-breakdown-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #94a3b8;
    }

    .token-breakdown-row {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .token-breakdown-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }

    .token-agent-name {
      color: #cbd5e1;
      font-weight: 500;
    }

    .token-agent-total {
      color: #f8fafc;
      font-weight: 700;
    }

    .token-breakdown-bar {
      width: 100%;
      height: 6px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(51, 65, 85, 0.7);
    }

    .token-breakdown-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #38bdf8 0%, #3b82f6 100%);
    }
  `]
})
export class ChatInputComponent {
  @Input() disabled = false;
  @Input() sessionId?: string;
  @Input() tokenUsage: TokenUsageSummary | null = null;
  
  @Output() send = new EventEmitter<string>();
  @Output() fileUpload = new EventEmitter<File>();
  
  @ViewChild('inputField') inputField!: ElementRef<HTMLTextAreaElement>;
  
  message = '';
  tokenUsageOpen = false;

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.tokenUsageOpen) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.token-usage-inline')) {
      this.tokenUsageOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.tokenUsageOpen = false;
  }

  toggleTokenUsagePopup(event?: MouseEvent): void {
    event?.stopPropagation();
    this.tokenUsageOpen = !this.tokenUsageOpen;
  }

  closeTokenUsagePopup(): void {
    this.tokenUsageOpen = false;
  }

  getUsagePercent(value: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (value / total) * 100));
  }

  formatCompactTokens(value: number): string {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    }
    return value.toLocaleString();
  }
  
  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }
  
  sendMessage(): void {
    if (this.message.trim() && !this.disabled) {
      this.send.emit(this.message.trim());
      this.message = '';
      this.resetTextareaHeight();
    }
  }
  
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.fileUpload.emit(input.files[0]);
      input.value = '';
    }
  }
  
  private resetTextareaHeight(): void {
    const textarea = this.inputField?.nativeElement;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }
}
