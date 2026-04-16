import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
  ViewChild,
  ElementRef,
  AfterViewInit,
  HostListener,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-html-preview-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="preview-panel" [class.open]="isOpen" [style.width.px]="isOpen ? panelWidth : 0">
      <!-- Drag handle for horizontal resize -->
      <div
        class="resize-handle"
        (mousedown)="onResizeStart($event)"
        title="Drag to resize"
      ></div>

      <div class="panel-header">
        <div class="panel-title">
          <span class="material-icons">preview</span>
          HTML Preview
        </div>
        <button class="close-btn" (click)="close.emit()" title="Close preview">
          <span class="material-icons">close</span>
        </button>
      </div>

      <div class="panel-content">
        <iframe
          #previewFrame
          sandbox="allow-scripts"
          title="HTML Preview"
          class="preview-iframe"
        ></iframe>
      </div>

      <div class="panel-actions">
        @if (!showFeedbackInput) {
          <button class="btn btn-approve" (click)="onApprove()">
            <span class="material-icons">check_circle</span>
            Approve
          </button>
          <button class="btn btn-feedback" (click)="showFeedbackInput = true">
            <span class="material-icons">edit_note</span>
            Request Changes
          </button>
        } @else {
          <div class="feedback-form">
            <textarea
              #feedbackInput
              [(ngModel)]="feedbackText"
              placeholder="Describe the changes you'd like..."
              rows="3"
              class="feedback-textarea"
              (keydown.enter)="onSubmitFeedback($event)"
            ></textarea>
            <div class="feedback-buttons">
              <button class="btn btn-cancel" (click)="showFeedbackInput = false; feedbackText = ''">
                Cancel
              </button>
              <button
                class="btn btn-send"
                [disabled]="!feedbackText.trim()"
                (click)="onSubmitFeedback()"
              >
                <span class="material-icons">send</span>
                Send Feedback
              </button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .preview-panel {
      position: relative;
      display: flex;
      flex-direction: column;
      width: 0;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      border-left: 1px solid var(--border-color);
      background: var(--bg-primary);
      transition: width 0.25s ease, min-width 0.25s ease;

      &.open {
        min-width: 360px;
      }
    }

    .resize-handle {
      position: absolute;
      top: 0;
      left: 0;
      width: 5px;
      height: 100%;
      cursor: col-resize;
      z-index: 10;
      background: transparent;

      &:hover,
      &:active {
        background: var(--primary);
        opacity: 0.3;
      }
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .panel-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);

      .material-icons {
        font-size: 20px;
        color: var(--primary);
      }
    }

    .close-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      color: var(--text-muted);
      display: flex;
      align-items: center;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .panel-content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .preview-iframe {
      flex: 1;
      width: 100%;
      min-height: 0;
      border: none;
      background: #fff;
    }

    .panel-actions {
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
      display: flex;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      flex-shrink: 0;
    }

    .btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      .material-icons { font-size: 18px; }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-approve {
      background: #10a37f;
      color: #fff;

      &:hover:not(:disabled) { background: #0d8c6d; }
    }

    .btn-feedback {
      background: var(--bg-tertiary);
      color: var(--text-primary);

      &:hover:not(:disabled) { background: var(--bg-hover); }
    }

    .btn-cancel {
      background: var(--bg-tertiary);
      color: var(--text-muted);

      &:hover { background: var(--bg-hover); }
    }

    .btn-send {
      background: var(--primary);
      color: #fff;

      &:hover:not(:disabled) { filter: brightness(1.1); }
    }

    .feedback-form {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .feedback-textarea {
      width: 100%;
      resize: vertical;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      box-sizing: border-box;

      &:focus {
        outline: none;
        border-color: var(--primary);
      }
    }

    .feedback-buttons {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
    }
  `],
})
export class HtmlPreviewPanelComponent implements OnChanges, AfterViewInit {
  @Input() html = '';
  @Input() isOpen = false;
  @Output() close = new EventEmitter<void>();
  @Output() approve = new EventEmitter<void>();
  @Output() feedback = new EventEmitter<string>();

  @ViewChild('previewFrame') previewFrame!: ElementRef<HTMLIFrameElement>;

  showFeedbackInput = false;
  feedbackText = '';
  panelWidth = 600; // default width in px
  private frameReady = false;
  private resizing = false;

  ngAfterViewInit(): void {
    this.frameReady = true;
    if (this.html) {
      this.renderHtml();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['html'] || changes['isOpen']) && this.frameReady) {
      // Delay slightly so the panel has time to expand before writing to iframe
      setTimeout(() => this.renderHtml(), 50);
    }
    if (changes['html']) {
      this.showFeedbackInput = false;
      this.feedbackText = '';
    }
  }

  // ── Drag-to-resize ──
  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.resizing = true;
  }

  @HostListener('document:mousemove', ['$event'])
  onResizeMove(event: MouseEvent): void {
    if (!this.resizing) return;
    // Panel is on the right side; width = viewport right edge minus mouse X
    const newWidth = window.innerWidth - event.clientX;
    this.panelWidth = Math.max(360, Math.min(newWidth, window.innerWidth * 0.8));
  }

  @HostListener('document:mouseup')
  onResizeEnd(): void {
    this.resizing = false;
  }

  onApprove(): void {
    this.approve.emit();
  }

  onSubmitFeedback(event?: Event): void {
    if (event instanceof KeyboardEvent && !event.shiftKey) {
      event.preventDefault();
    } else if (event instanceof KeyboardEvent) {
      return;
    }
    const text = this.feedbackText.trim();
    if (!text) return;
    this.feedback.emit(text);
    this.feedbackText = '';
    this.showFeedbackInput = false;
  }

  private renderHtml(): void {
    if (!this.previewFrame?.nativeElement) return;
    const iframe = this.previewFrame.nativeElement;
    iframe.srcdoc = this.html || '';
  }
}
