import { Component, Input, Output, EventEmitter, ViewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

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
        >
          <span class="material-icons">send</span>
        </button>
      </div>
      
      <div class="input-footer">
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
      padding: var(--spacing-sm) var(--spacing-md);
    }
    
    .input-footer {
      display: flex;
      justify-content: flex-end;
      padding-top: var(--spacing-xs);
    }
    
    .char-count {
      font-size: 12px;
      color: var(--text-muted);
      
      &.warning {
        color: var(--warning);
      }
    }
  `]
})
export class ChatInputComponent {
  @Input() disabled = false;
  @Input() sessionId?: string;
  
  @Output() send = new EventEmitter<string>();
  @Output() fileUpload = new EventEmitter<File>();
  
  @ViewChild('inputField') inputField!: ElementRef<HTMLTextAreaElement>;
  
  message = '';
  
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
