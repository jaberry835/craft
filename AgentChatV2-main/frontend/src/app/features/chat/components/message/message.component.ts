import { Component, Input, DoCheck, ViewChild, ElementRef, AfterViewChecked, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';

import { Message } from '../../../../core/services/chat.service';
import { SettingsService } from '../../../../core/services/settings.service';

// Import chatter event type from parent
interface ChatterEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'delegation' | 'content' | 'reasoning';
  agentName: string;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;      // AG-UI tool_call_id for matching start/args/end/result
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
          <span class="message-role">{{ getDisplayRole() }}</span>
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
                    @if (event.content && event.type === 'reasoning') {
                      <div class="chatter-event-content">
                        <div class="reasoning-content">{{ truncateContent(event.content, 500) }}</div>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }
        
        @if (hasImageAttachment()) {
          <div class="image-attachment">
            <img [src]="getImageDataUrl()" [alt]="getImageFilename()" class="chat-image" />
            <span class="image-label">
              <span class="material-icons">image</span>
              {{ getImageFilename() }}
            </span>
          </div>
        } @else {
          <div class="message-text" [innerHTML]="formatContent(message.content)"></div>
        }
        
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
      
      &.activity-reasoning {
        .activity-icon {
          color: #06b6d4;
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
      
      &.chatter-reasoning {
        background-color: rgba(6, 182, 212, 0.05);
        
        .chatter-event-header .material-icons {
          color: #06b6d4;
        }
      }
    }
    
    .reasoning-content {
      font-size: 12px;
      color: var(--text-secondary);
      font-style: italic;
      line-height: 1.5;
      white-space: pre-wrap;
      background-color: rgba(6, 182, 212, 0.05);
      border-left: 3px solid #06b6d4;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: 0 4px 4px 0;
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

    .image-attachment {
      margin: var(--spacing-sm) 0;

      .chat-image {
        max-width: 400px;
        max-height: 400px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
        cursor: pointer;
        transition: transform 0.2s;
        display: block;

        &:hover {
          transform: scale(1.02);
        }
      }

      .image-label {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
        font-size: 12px;
        color: var(--text-muted);

        .material-icons {
          font-size: 14px;
        }
      }
    }

    .message-text {
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;

      /* Paragraphs */
      :deep(p) {
        margin: 0 0 0.6em 0;
        &:last-child { margin-bottom: 0; }
      }

      /* Headings — kept compact for chat context */
      :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) {
        line-height: 1.35;
        color: var(--text-primary);
        &:first-child { margin-top: 0; }
      }
      :deep(h1) {
        font-size: 1.15em;
        font-weight: 700;
        margin: 1.1em 0 0.5em 0;
        padding-bottom: 0.3em;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(h2) {
        font-size: 1.05em;
        font-weight: 700;
        margin: 1em 0 0.4em 0;
        padding-bottom: 0.25em;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(h3) {
        font-size: 0.95em;
        font-weight: 600;
        margin: 0.85em 0 0.3em 0;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-secondary);
      }
      :deep(h4), :deep(h5), :deep(h6) {
        font-size: 0.9em;
        font-weight: 600;
        margin: 0.75em 0 0.25em 0;
        color: var(--text-secondary);
      }

      /* Links */
      :deep(a) {
        color: var(--md-link) !important;
        text-decoration: none;
        border-bottom: 1px solid var(--md-link-border);
        transition: border-color 0.2s ease, color 0.2s ease;
        
        &:visited {
          color: var(--md-link-visited) !important;
        }
        
        &:hover {
          color: var(--md-link-hover) !important;
          border-bottom-color: var(--md-link);
        }
        
        &::after {
          content: '↗';
          font-size: 0.7em;
          margin-left: 2px;
          opacity: 0.5;
          vertical-align: super;
        }
        
        &.doc-citation {
          color: #90caf9 !important;
          border-bottom-style: dotted;
          
          &:visited {
            color: #90caf9 !important;
          }
          
          &::before {
            content: '📄 ';
            font-size: 0.85em;
          }
        }
      }

      /* Inline code */
      :deep(code) {
        background-color: var(--md-code-bg);
        border: 1px solid var(--md-code-border);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 0.9em;
        color: var(--md-code-color);
      }

      /* Code blocks */
      :deep(pre) {
        background-color: var(--md-pre-bg);
        border: 1px solid var(--border-color);
        padding: var(--spacing-md);
        border-radius: 8px;
        overflow-x: auto;
        margin: 0.75em 0;
        
        code {
          background: none;
          border: none;
          padding: 0;
          font-size: 13px;
          line-height: 1.5;
          color: var(--text-secondary);
        }
      }

      /* Lists — main spacing handled in global styles.scss to override * reset */
      :deep(li) {
        &::marker {
          color: var(--text-muted);
        }
      }
      /* Tighter lists: remove paragraph margins inside li */
      :deep(li > p) {
        margin: 0;
      }

      /* Blockquotes */
      :deep(blockquote) {
        margin: 0.6em 0;
        padding: 0.4em 0.8em;
        border-left: 3px solid var(--primary);
        background-color: var(--md-blockquote-bg);
        border-radius: 0 6px 6px 0;
        color: var(--text-secondary);
        font-style: italic;
        
        p {
          margin: 0.2em 0;
        }
      }

      /* Tables */
      :deep(table) {
        width: max-content;
        max-width: 100%;
        border-collapse: collapse;
        margin: 0.75em 0;
        font-size: 13px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        overflow: hidden;
        display: table;
      }
      :deep(thead) {
        background-color: var(--md-table-head-bg);
      }
      :deep(th) {
        padding: 8px 14px;
        text-align: left;
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-color);
      }
      :deep(td) {
        padding: 6px 14px;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(tbody tr):last-child td {
        border-bottom: none;
      }
      :deep(tbody tr):hover {
        background-color: var(--md-table-stripe);
      }

      /* Horizontal rule — subtle separator in chat */
      :deep(hr) {
        border: none;
        height: 1px;
        background: linear-gradient(
          to right,
          transparent,
          var(--border-color) 20%,
          var(--border-color) 80%,
          transparent
        );
        margin: 0.8em 0;
      }

      /* Strong / emphasis */
      :deep(strong) {
        font-weight: 600;
        color: var(--text-primary);
      }
      :deep(em) {
        font-style: italic;
        color: var(--text-secondary);
      }

      /* Images */
      :deep(img) {
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid var(--border-color);
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
export class MessageComponent implements DoCheck, OnInit {
  @Input() message!: DisplayMessage;
  @Input() isStreaming = false;
  /** IDs of selected agents that have document grounding — used for auto-linking filenames */
  @Input() groundedAgentIds: string[] = [];
  
  @ViewChild('chatterContainer') chatterContainer?: ElementRef<HTMLDivElement>;
  
  chatterExpanded = false;  // Technical details are collapsed by default
  private previousChatterCount = 0;
  private shouldScrollToBottom = false;
  private md!: ReturnType<typeof marked.use>;
  
  constructor(
    private http: HttpClient,
    private settingsService: SettingsService
  ) {}

  getDisplayRole(): string {
    if (this.message.role === 'user') return 'You';
    const configured = this.settingsService.currentSettings.assistant_display_name?.trim();
    return configured || 'Assistant';
  }

  ngOnInit(): void {
    // Configure marked with sensible defaults
    this.md = marked.use({
      breaks: true,
      gfm: true,
    });
  }
  
  /**
   * Intercept clicks on .doc-citation links.
   * Instead of navigating (which loses the Authorization header),
   * fetch the document via HttpClient and open a blob URL in a new tab.
   */
  @HostListener('click', ['$event'])
  onDocCitationClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a.doc-citation') as HTMLAnchorElement | null;
    if (!anchor) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const url = anchor.getAttribute('href');
    if (!url) return;
    
    // Fetch with auth header (Angular's HttpInterceptor adds Bearer token)
    this.http.get(url, { responseType: 'blob', observe: 'response' }).subscribe({
      next: (response) => {
        const blob = response.body;
        if (!blob) return;
        const contentType = response.headers.get('Content-Type') || 'text/plain';
        const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
        window.open(blobUrl, '_blank');
        // Revoke after a delay to allow the tab to load
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      },
      error: (err) => {
        console.error('Failed to fetch grounding document:', err);
        if (err.status === 403) {
          alert('You do not have permission to view this document.');
        } else if (err.status === 404) {
          alert('Document not found.');
        } else {
          alert('Failed to load document. Please try again.');
        }
      }
    });
  }
  
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
    // Use marked for full markdown rendering
    let result = (this.md ? this.md.parse(content) : marked.parse(content)) as string;
    
    // Open all links in new tabs
    result = result.replace(/<a\s+href="/g, '<a target="_blank" rel="noopener noreferrer" href="');
    
    // Rewrite Azure Blob Storage URLs to use the backend blob proxy.
    // This applies to ALL assistant messages — MCP tools often return direct
    // blob URLs that the user can't access without SAS tokens.  The proxy
    // uses managed identity and applies SS token checks.
    if (this.message.role === 'assistant') {
      const blobUrlPattern = /(<a\s[^>]*href=")(https:\/\/[^"]+\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\/[^"]+)("[^>]*>)/gi;
      result = result.replace(blobUrlPattern, (_m, prefix, blobUrl, suffix) => {
        const proxyUrl = `/api/documents/blob-proxy?url=${encodeURIComponent(blobUrl)}`;
        // Add doc-citation class for the click interceptor
        const classedSuffix = suffix.includes('class="')
          ? suffix.replace('class="', 'class="doc-citation ')
          : suffix.replace('>', ' class="doc-citation">');
        return `${prefix}${proxyUrl}${classedSuffix}`;
      });
    }
    
    // Auto-link grounding document file names (e.g., meeting-snack-policy.md)
    // Only for assistant messages from agents that have document grounding configured.
    // This prevents interference with non-grounded agents (e.g., MCP-only agents
    // whose tool results may contain filenames that should NOT become grounding links).
    if (this.message.role === 'assistant' && this.groundedAgentIds.length > 0) {
      const agentId = this.groundedAgentIds[0];
      const docExtensions = 'md|txt|json|csv|pdf';
      const fileNameRe = `[\\w][\\w.-]*\\.(?:${docExtensions})`;
      
      // Step 1: Rewrite any existing <a href="...filename.ext"> links created by the
      // markdown converter (LLM wrote [file.md](file.md) or [file.md](sandbox:/file.md))
      // — redirect them to the grounding proxy.  Strip any scheme/path prefix before the filename.
      const existingLinkPattern = new RegExp(
        `(<a\\s[^>]*href=")(?:[^"]*/)?(${fileNameRe})("[^>]*>)`, 'gi'
      );
      result = result.replace(existingLinkPattern, (_m, prefix, fileName, suffix) => {
        const url = `/api/documents/grounding/${agentId}/${encodeURIComponent(fileName)}`;
        // Ensure the doc-citation class is added
        const classAttr = suffix.includes('class="') 
          ? suffix.replace('class="', 'class="doc-citation ') 
          : suffix.replace('>', ' class="doc-citation">');
        return `${prefix}${url}${classAttr}`;
      });
      
      // Step 2: Auto-link bare filenames in text segments that are NOT inside <a>...</a> tags.
      const fileNamePattern = new RegExp(`\\b(${fileNameRe})\\b`, 'g');
      // Track whether we're inside an <a> tag to avoid nesting anchors.
      let insideAnchor = false;
      result = result.replace(
        /(<a\b[^>]*>)|(<\/a>)|(<[^>]+>)|([^<]+)/gi,
        (_wholeMatch, openA, closeA, otherTag, text) => {
          if (openA) { insideAnchor = true; return openA; }
          if (closeA) { insideAnchor = false; return closeA; }
          if (otherTag) return otherTag;
          // Only auto-link in text that's NOT inside an existing <a> tag
          if (insideAnchor || !text) return text || '';
          return text.replace(fileNamePattern, (_fm: string, fileName: string) => {
            const url = `/api/documents/grounding/${agentId}/${encodeURIComponent(fileName)}`;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="doc-citation">${fileName}</a>`;
          });
        }
      );
    }
    
    return result;
  }
  
  /**
   * Check if this message has an image attachment in metadata.
   */
  hasImageAttachment(): boolean {
    const metadata = (this.message as any).metadata;
    return !!metadata?.['image_attachment'];
  }

  /**
   * Build a data URL from the base64 image attachment.
   */
  getImageDataUrl(): string {
    const metadata = (this.message as any).metadata;
    const img = metadata?.['image_attachment'] as Record<string, unknown> | undefined;
    if (!img) return '';
    return `data:${img['content_type']};base64,${img['base64']}`;
  }

  /**
   * Get the original filename from the image attachment.
   */
  getImageFilename(): string {
    const metadata = (this.message as any).metadata;
    const img = metadata?.['image_attachment'] as Record<string, unknown> | undefined;
    return (img?.['filename'] as string) || 'Image';
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
      case 'reasoning': return 'neurology';
      default: return 'info';
    }
  }
  
  formatChatterType(type: string): string {
    switch (type) {
      case 'tool_call': return 'calling tool';
      case 'tool_result': return 'got result';
      case 'delegation': return 'delegating';
      case 'thinking': return 'thinking';
      case 'reasoning': return 'reasoning';
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
      case 'reasoning': return 'neurology';
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
      case 'reasoning':
        return event.content ? this.truncateContent(event.content, 80) : 'Reasoning...';
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
