import { Component, Input, DoCheck, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Message } from '../../../../core/services/chat.service';

// Import chatter event type from parent
interface ChatterEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'delegation' | 'content';
  agentName: string;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;      // Duration of tool execution in ms
  tokensInput?: number;     // Input tokens for LLM calls
  tokensOutput?: number;    // Output tokens for LLM calls
  friendlyMessage?: string; // User-friendly description of the action
}

interface DisplayMessage extends Message {
  isStreaming?: boolean;
  agentResponses?: { agentName: string; content: string }[];
  chatterEvents?: ChatterEvent[];
}

@Component({
  selector: 'app-message',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="message" [class.user]="message.role === 'user'" [class.assistant]="message.role === 'assistant'">
      <div class="message-avatar">
        @if (message.role === 'user') {
          <span class="material-icons">person</span>
        } @else {
          <span class="material-icons">smart_toy</span>
        }
      </div>
      
      <div class="message-content">
        <div class="message-header">
          <span class="message-role">{{ message.role === 'user' ? 'You' : 'Assistant' }}</span>
          <span class="message-time">{{ formatTime(message.timestamp) }}</span>
        </div>
        
        <!-- Agent Activity Section (simplified view by default) -->
        @if (hasChatterEvents()) {
          <div class="chatter-section" [class.expanded]="chatterExpanded" [class.streaming]="isStreaming">
            <!-- Simplified activity feed (always visible when streaming) -->
            <div class="activity-feed" #chatterContainer>
              @for (event of getChatterEvents(); track $index) {
                <div class="activity-item" [class]="'activity-' + event.type">
                  <span class="material-icons activity-icon">{{ getActivityIcon(event.type) }}</span>
                  <span class="activity-agent">{{ event.agentName }}</span>
                  <span class="activity-message">{{ getActivityMessage(event) }}</span>
                  @if (event.durationMs && event.type === 'tool_result') {
                    <span class="activity-duration">{{ formatDuration(event.durationMs) }}</span>
                  }
                </div>
              }
              @if (isStreaming) {
                <div class="activity-item activity-working">
                  <span class="material-icons activity-icon spinning">sync</span>
                  <span class="activity-message">Working...</span>
                </div>
              }
            </div>
            
            <!-- Technical details toggle -->
            <button class="details-toggle" (click)="chatterExpanded = !chatterExpanded">
              <span class="material-icons">{{ chatterExpanded ? 'expand_less' : 'expand_more' }}</span>
              <span>{{ chatterExpanded ? 'Hide' : 'Show' }} technical details</span>
            </button>
            
            <!-- Expanded technical view -->
            @if (chatterExpanded) {
              <div class="chatter-events">
                @for (event of getChatterEvents(); track $index) {
                  <div class="chatter-event" [class]="'chatter-' + event.type">
                    <div class="chatter-event-header">
                      <span class="material-icons">{{ getChatterIcon(event.type) }}</span>
                      <span class="chatter-agent">{{ event.agentName }}</span>
                      <span class="chatter-type">{{ formatChatterType(event.type) }}</span>
                      @if (event.toolName) {
                        <span class="chatter-tool">{{ event.toolName }}</span>
                      }
                      @if (event.durationMs) {
                        <span class="chatter-duration" title="Execution time for this operation">{{ formatDuration(event.durationMs) }}</span>
                      }
                      @if (event.tokensInput || event.tokensOutput) {
                        <span class="chatter-tokens" [title]="getTokensTooltip(event.tokensInput, event.tokensOutput)">
                          <span class="material-icons">token</span>
                          {{ formatTokenCount(event.tokensInput) }} → {{ formatTokenCount(event.tokensOutput) }}
                        </span>
                      }
                    </div>
                    @if (hasToolArgs(event.toolArgs)) {
                      <div class="chatter-event-content">
                        <pre class="tool-args">{{ formatToolArgs(event.toolArgs) }}</pre>
                      </div>
                    }
                    @if (event.content && event.type === 'tool_result') {
                      <div class="chatter-event-content">
                        <div class="tool-result">{{ truncateContent(event.content, 300) }}</div>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }
        
        <div class="message-text" [innerHTML]="formatContent(message.content)"></div>
        
        @if (isStreaming) {
          <span class="typing-indicator">
            <span></span><span></span><span></span>
          </span>
        }
      </div>
    </div>
  `,
  styles: [`
    .message {
      display: flex;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      border-radius: 8px;
      animation: slideIn var(--transition-normal);
      
      &.user {
        background-color: var(--bg-secondary);
        
        .message-avatar {
          background-color: var(--primary);
        }
      }
      
      &.assistant {
        background-color: var(--bg-tertiary);
        
        .message-avatar {
          background-color: #10a37f;
        }
      }
    }
    
    .message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      
      .material-icons {
        font-size: 20px;
        color: white;
      }
    }
    
    .message-content {
      flex: 1;
      min-width: 0;
    }
    
    .message-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
    }
    
    .message-role {
      font-weight: 600;
      font-size: 14px;
    }
    
    .message-time {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    /* Chatter Section Styles */
    .chatter-section {
      margin: var(--spacing-sm) 0;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: var(--bg-primary);
      overflow: hidden;
      
      &.streaming {
        border-color: var(--primary);
        box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.2);
      }
    }
    
    /* Simplified Activity Feed */
    .activity-feed {
      padding: var(--spacing-sm) var(--spacing-md);
      max-height: 150px;
      overflow-y: auto;
    }
    
    .activity-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: 4px 0;
      font-size: 13px;
      color: var(--text-secondary);
      
      &.activity-tool_call {
        .activity-icon {
          color: #3b82f6;
        }
      }
      
      &.activity-tool_result {
        .activity-icon {
          color: #10b981;
        }
      }
      
      &.activity-delegation {
        .activity-icon {
          color: #8b5cf6;
        }
      }
      
      &.activity-thinking {
        .activity-icon {
          color: #f59e0b;
        }
      }
      
      &.activity-working {
        color: var(--text-muted);
        font-style: italic;
        
        .activity-icon {
          color: var(--primary);
        }
      }
    }
    
    .activity-icon {
      font-size: 16px;
      flex-shrink: 0;
      
      &.spinning {
        animation: spin 1s linear infinite;
      }
    }
    
    .activity-agent {
      font-weight: 600;
      color: var(--text-primary);
      flex-shrink: 0;
    }
    
    .activity-message {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .activity-duration {
      flex-shrink: 0;
      font-size: 11px;
      color: #10b981;
      background-color: rgba(16, 185, 129, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
    }
    
    .details-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-xs);
      padding: 6px var(--spacing-md);
      background: var(--bg-secondary);
      border: none;
      border-top: 1px solid var(--border-color);
      cursor: pointer;
      color: var(--text-muted);
      font-size: 12px;
      transition: background-color var(--transition-fast);
      
      &:hover {
        background-color: var(--bg-hover);
        color: var(--text-secondary);
      }
      
      .material-icons {
        font-size: 16px;
      }
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .chatter-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm) var(--spacing-md);
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 13px;
      transition: background-color var(--transition-fast);
      
      &:hover {
        background-color: var(--bg-secondary);
      }
      
      .material-icons {
        font-size: 18px;
      }
      
      .chatter-icon {
        color: var(--primary);
      }
    }
    
    .chatter-events {
      border-top: 1px solid var(--border-color);
      max-height: 300px;
      overflow-y: auto;
    }
    
    .chatter-event {
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      
      &:last-child {
        border-bottom: none;
      }
      
      &.chatter-tool_call {
        background-color: rgba(59, 130, 246, 0.05);
        
        .chatter-event-header .material-icons {
          color: #3b82f6;
        }
      }
      
      &.chatter-tool_result {
        background-color: rgba(16, 185, 129, 0.05);
        
        .chatter-event-header .material-icons {
          color: #10b981;
        }
      }
      
      &.chatter-delegation {
        background-color: rgba(139, 92, 246, 0.05);
        
        .chatter-event-header .material-icons {
          color: #8b5cf6;
        }
      }
    }
    
    .chatter-event-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      
      .material-icons {
        font-size: 16px;
      }
      
      .chatter-agent {
        font-weight: 600;
        color: var(--text-primary);
      }
      
      .chatter-type {
        color: var(--text-muted);
        text-transform: capitalize;
      }
      
      .chatter-tool {
        background-color: var(--bg-secondary);
        padding: 2px 8px;
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', monospace;
        color: var(--primary);
      }
      
      .chatter-duration {
        margin-left: auto;
        background-color: rgba(16, 185, 129, 0.1);
        color: #10b981;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
      }
      
      .chatter-tokens {
        display: flex;
        align-items: center;
        gap: 2px;
        background-color: rgba(139, 92, 246, 0.1);
        color: #8b5cf6;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        
        .material-icons {
          font-size: 12px;
        }
      }
    }
    
    .chatter-event-content {
      margin-top: var(--spacing-xs);
      margin-left: 24px;
    }
    
    .tool-args {
      font-size: 11px;
      background-color: var(--bg-secondary);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: 4px;
      overflow-x: auto;
      max-height: 100px;
      margin: 0;
    }
    
    .tool-result {
      font-size: 12px;
      color: var(--text-secondary);
      background-color: var(--bg-secondary);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: 4px;
      max-height: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .delegation-msg {
      font-size: 12px;
      color: var(--text-secondary);
      font-style: italic;
    }
    
    .message-text {
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      
      :deep(a) {
        color: #ffffff !important;
        text-decoration: underline;
        text-underline-offset: 2px;
        transition: opacity 0.2s ease;
        
        &:visited {
          color: #ffffff !important;
        }
        
        &:hover {
          opacity: 0.8;
        }
        
        &::after {
          content: '↗';
          font-size: 0.75em;
          margin-left: 2px;
          opacity: 0.7;
        }
      }
      
      :deep(code) {
        background-color: var(--bg-primary);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 13px;
      }
      
      :deep(pre) {
        background-color: var(--bg-primary);
        padding: var(--spacing-md);
        border-radius: 6px;
        overflow-x: auto;
        margin: var(--spacing-sm) 0;
        
        code {
          background: none;
          padding: 0;
        }
      }
    }
    
    .typing-indicator {
      display: inline-flex;
      gap: 4px;
      padding: var(--spacing-xs) 0;
      
      span {
        width: 8px;
        height: 8px;
        background-color: var(--text-muted);
        border-radius: 50%;
        animation: bounce 1.4s infinite ease-in-out both;
        
        &:nth-child(1) { animation-delay: -0.32s; }
        &:nth-child(2) { animation-delay: -0.16s; }
      }
    }
    
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `]
})
export class MessageComponent implements DoCheck {
  @Input() message!: DisplayMessage;
  @Input() isStreaming = false;
  
  @ViewChild('chatterContainer') chatterContainer?: ElementRef<HTMLDivElement>;
  
  chatterExpanded = false;  // Technical details are collapsed by default
  private previousChatterCount = 0;
  private shouldScrollToBottom = false;
  
  ngDoCheck(): void {
    // Auto-scroll activity feed when new events arrive during streaming
    if (this.isStreaming && this.hasChatterEvents()) {
      const currentCount = this.getChatterEvents().length;
      if (currentCount > this.previousChatterCount) {
        this.previousChatterCount = currentCount;
        this.shouldScrollToBottom = true;  // Flag to scroll after view updates
      }
    }
    // Reset counter when streaming ends
    if (!this.isStreaming && this.previousChatterCount > 0) {
      this.previousChatterCount = 0;
    }
  }
  
  ngAfterViewChecked(): void {
    // Auto-scroll to bottom when new chatter events arrive
    if (this.shouldScrollToBottom && this.chatterContainer) {
      const container = this.chatterContainer.nativeElement;
      container.scrollTop = container.scrollHeight;
      this.shouldScrollToBottom = false;
    }
  }
  
  formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  formatContent(content: string): string {
    // Basic markdown-like formatting
    return content
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Markdown links: [text](url) -> clickable link that opens in new tab
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  
  hasChatterEvents(): boolean {
    return !!(this.message as DisplayMessage).chatterEvents?.length;
  }
  
  getChatterEvents(): ChatterEvent[] {
    return (this.message as DisplayMessage).chatterEvents || [];
  }
  
  hasToolArgs(args: Record<string, unknown> | undefined): boolean {
    return !!args && Object.keys(args).length > 0;
  }
  
  getChatterIcon(type: string): string {
    switch (type) {
      case 'tool_call': return 'build';
      case 'tool_result': return 'check_circle';
      case 'delegation': return 'forward';
      case 'thinking': return 'psychology';
      default: return 'info';
    }
  }
  
  formatChatterType(type: string): string {
    switch (type) {
      case 'tool_call': return 'calling tool';
      case 'tool_result': return 'got result';
      case 'delegation': return 'delegating';
      case 'thinking': return 'thinking';
      default: return type;
    }
  }
  
  formatToolArgs(args?: Record<string, unknown>): string {
    if (!args) return '';
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  
  formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }
  
  formatTokenCount(count?: number): string {
    if (!count) return '0';
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  }
  
  getTokensTooltip(input?: number, output?: number): string {
    const inputVal = input || 0;
    const outputVal = output || 0;
    const total = inputVal + outputVal;
    return `Token usage for this LLM call:\n• Input: ${inputVal.toLocaleString()} tokens (context sent to model)\n• Output: ${outputVal.toLocaleString()} tokens (response generated)\n• Total: ${total.toLocaleString()} tokens`;
  }
  
  truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  }
  
  /**
   * Get a simplified icon for the activity feed
   */
  getActivityIcon(type: string): string {
    switch (type) {
      case 'tool_call': return 'search';
      case 'tool_result': return 'check_circle';
      case 'delegation': return 'arrow_forward';
      case 'thinking': return 'lightbulb';
      case 'content': return 'done_all';
      default: return 'info';
    }
  }
  
  /**
   * Get a user-friendly message for the activity feed
   * Uses the friendlyMessage if available, otherwise falls back to content
   */
  getActivityMessage(event: ChatterEvent): string {
    // Prefer the friendly message from backend
    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }
    
    // Fallback: generate friendly message from event type and content
    switch (event.type) {
      case 'tool_call':
        return event.toolName ? `Using ${this.humanizeToolName(event.toolName)}...` : 'Calling a tool...';
      case 'tool_result':
        return 'Got results';
      case 'delegation':
        return event.content ? `Asking: "${this.truncateContent(event.content, 60)}"` : 'Delegating task...';
      case 'thinking':
        return 'Processing...';
      case 'content':
        return event.content || 'Completed';
      default:
        return event.content || 'Working...';
    }
  }
  
  /**
   * Convert tool names to more readable format
   */
  private humanizeToolName(toolName: string): string {
    // Convert snake_case or camelCase to readable text
    return toolName
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase();
  }
}
