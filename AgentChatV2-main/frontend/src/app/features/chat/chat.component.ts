import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';

import { ChatService, Message, Session, AGUIEvent } from '../../core/services/chat.service';
import { AgentService, AgentConfig } from '../../core/services/agent.service';
import { SessionStateService } from '../../core/services/session-state.service';
import { DocumentService, DocumentMetadata } from '../../core/services/document.service';
import { HtmlPreviewService } from '../../core/services/html-preview.service';
import { MessageComponent } from './components/message/message.component';
import { ChatInputComponent } from './components/chat-input/chat-input.component';
import { AgentSelectorComponent } from './components/agent-selector/agent-selector.component';
import { HtmlPreviewPanelComponent } from './components/html-preview-panel/html-preview-panel.component';


// Chatter event for displaying agent thought process
export interface ChatterEvent {
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
  renderHint?: 'json' | 'table' | 'text'; // How to render tool result content
}

interface DisplayMessage extends Message {
  isStreaming?: boolean;
  agentResponses?: { agentName: string; content: string }[];
  chatterEvents?: ChatterEvent[];
}

// UploadedFile wraps document response with UI state
interface UploadedFile {
  document: DocumentMetadata;
  isUploading?: boolean;
  error?: string;
}

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
  selector: 'app-chat',
  standalone: true,
  imports: [
    FormsModule,
    MessageComponent,
    ChatInputComponent,
    AgentSelectorComponent,
    HtmlPreviewPanelComponent
  ],
  template: `
    <div class="chat-with-preview">
      <div class="chat-container">
      <!-- Active agents bar - shows when in a session with agents -->
      @if (sessionId && selectedAgentIds.length > 0 && agents.length > 0) {
        <div class="active-agents-bar">
          <div class="agents-list">
            @for (agent of getSelectedAgents(); track agent.id) {
              <div 
                class="agent-chip" 
                [class.orchestrator]="agent.is_orchestrator"
                [title]="agent.description || agent.name"
              >
                <span class="material-icons">{{ agent.is_orchestrator ? 'hub' : 'smart_toy' }}</span>
                <span class="agent-name">{{ agent.name }}</span>
                @if (agent.model) {
                  <span class="agent-model">{{ agent.model }}</span>
                }
              </div>
            }
          </div>
          <div class="orchestration-badge">
            <span class="material-icons">account_tree</span>
            {{ orchestrationType }}
          </div>
        </div>
      }
      
      <!-- Agent selector for new chats -->
      @if (!sessionId) {
        <app-agent-selector
          [agents]="agents"
          [selectedAgentIds]="selectedAgentIds"
          [orchestrationType]="orchestrationType"
          (agentToggle)="toggleAgent($event)"
          (orchestrationChange)="orchestrationType = $event"
        ></app-agent-selector>
      }
      
      <!-- Messages area -->
      <div class="messages-area" #messagesContainer>
        @if (hasMoreMessages) {
          <div class="load-older-messages">
            <button class="btn btn-secondary btn-sm" (click)="loadOlderMessages()" [disabled]="isLoadingOlder">
              @if (isLoadingOlder) {
                <span class="material-icons spinning">sync</span>
                Loading...
              } @else {
                <span class="material-icons">expand_less</span>
                Load older messages
              }
            </button>
          </div>
        }

        @if (messages.length === 0 && !isLoading) {
          <div class="empty-state">
            <span class="material-icons">forum</span>
            <h2>Start a conversation</h2>
            <p>Select agents and type your message below to begin.</p>
          </div>
        }
        
        @for (message of messages; track message.id; let i = $index) {
          <app-message 
            [message]="message"
            [isStreaming]="message.isStreaming ?? false"
            [groundedAgentIds]="groundedAgentIds"
            [structuredFormAgentIds]="selectedAgentIdsWithStructuredInputForm()"
            [isLastAssistantMessage]="isLastAssistant(i)"
            (formSubmit)="sendMessage($event)"
          ></app-message>
        }
        
        @if (streamingMessage) {
          <app-message 
            [message]="streamingMessage"
            [isStreaming]="true"
            [groundedAgentIds]="groundedAgentIds"
            [structuredFormAgentIds]="selectedAgentIdsWithStructuredInputForm()"
          ></app-message>
        }
        
        <div #scrollAnchor></div>
      </div>
      
      <!-- Upload error message -->
      @if (uploadError) {
        <div class="upload-error-bar">
          <span class="material-icons">error_outline</span>
          <span>{{ uploadError }}</span>
          <button class="dismiss-error" (click)="uploadError = undefined">
            <span class="material-icons">close</span>
          </button>
        </div>
      }
      
      <!-- Uploaded files bar -->
      @if (uploadedFiles.length > 0 || uploadingFile) {
        <div class="uploaded-files-bar">
          <div class="files-label">
            <span class="material-icons">description</span>
            Documents
          </div>
          <div class="files-list">
            @if (uploadingFile) {
              <div class="file-chip uploading">
                <span class="material-icons spinning">sync</span>
                <span class="file-name">{{ uploadingFile }}</span>
                <span class="file-status">Uploading...</span>
              </div>
            }
            @for (file of uploadedFiles; track file.document.id) {
              <div class="file-chip clickable" [title]="'Click to view: ' + file.document.title" (click)="openDocument(file)">
                <span class="material-icons">{{ getFileIcon(file.document.fileType) }}</span>
                <span class="file-name">{{ file.document.title }}</span>
                <span class="file-info">{{ file.document.chunksCount > 0 ? file.document.chunksCount + ' chunks' : 'image' }}</span>
                <button class="remove-file" (click)="removeFile(file); $event.stopPropagation()" title="Remove">
                  <span class="material-icons">close</span>
                </button>
              </div>
            }
          </div>
        </div>
      }
      
      <!-- Input area -->
      <app-chat-input
        [disabled]="isSending"
        [sessionId]="sessionId"
        [tokenUsage]="getTokenUsageSummary()"
        (send)="sendMessage($event)"
        (fileUpload)="handleFileUpload($event)"
      ></app-chat-input>
    </div>

    <!-- HTML Preview Side Panel -->
    <app-html-preview-panel
      [html]="previewService.html"
      [isOpen]="previewService.isOpen"
      (close)="closePreview()"
      (approve)="approvePreview()"
      (feedback)="sendPreviewFeedback($event)"
    ></app-html-preview-panel>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    
    .chat-with-preview {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    
    .chat-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background-color: var(--bg-primary);
    }
    
    .active-agents-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      gap: var(--spacing-md);
    }
    
    .agents-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    
    .agent-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background-color: var(--bg-tertiary);
      border-radius: 16px;
      font-size: 12px;
      cursor: default;
      transition: background-color var(--transition-fast);
      
      &:hover {
        background-color: var(--bg-hover);
      }
      
      .material-icons {
        font-size: 16px;
        color: var(--primary);
      }
      
      &.orchestrator {
        background-color: rgba(16, 163, 127, 0.15);
        
        .material-icons {
          color: #10a37f;
        }
      }
    }
    
    .agent-name {
      font-weight: 500;
      color: var(--text-primary);
    }
    
    .agent-model {
      color: var(--text-muted);
      font-size: 11px;
      padding-left: 6px;
      border-left: 1px solid var(--border-color);
    }
    
    .orchestration-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background-color: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 11px;
      color: var(--text-muted);
      text-transform: capitalize;
      
      .material-icons {
        font-size: 14px;
      }
    }
    
    .upload-error-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: rgba(220, 53, 69, 0.15);
      border-bottom: 1px solid rgba(220, 53, 69, 0.3);
      color: #ff6b6b;
      font-size: 13px;
      
      .material-icons {
        font-size: 18px;
      }
      
      .dismiss-error {
        margin-left: auto;
        background: none;
        border: none;
        color: #ff6b6b;
        cursor: pointer;
        padding: 2px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        
        &:hover {
          background-color: rgba(220, 53, 69, 0.2);
        }
        
        .material-icons {
          font-size: 16px;
        }
      }
    }
    
    .uploaded-files-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }
    
    .files-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      
      .material-icons {
        font-size: 16px;
      }
    }
    
    .files-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    
    .file-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background-color: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 12px;
      
      .material-icons {
        font-size: 16px;
        color: var(--primary);
      }
      
      &.clickable {
        cursor: pointer;
        transition: all var(--transition-fast);
        
        &:hover {
          background-color: var(--bg-secondary);
          transform: translateY(-1px);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
      }
      
      &.uploading {
        opacity: 0.7;
        
        .spinning {
          animation: spin 1s linear infinite;
        }
      }
    }
    
    .file-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .file-info, .file-status {
      color: var(--text-muted);
      font-size: 11px;
    }
    
    .remove-file {
      background: none;
      border: none;
      padding: 2px;
      cursor: pointer;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: all var(--transition-fast);
      
      .material-icons {
        font-size: 14px;
        color: inherit;
      }
      
      &:hover {
        background-color: var(--bg-hover);
        color: var(--error);
      }
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .messages-area {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-lg);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .load-older-messages {
      display: flex;
      justify-content: center;
      padding: var(--spacing-sm) 0;

      button {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 13px;
      }

      .spinning {
        animation: spin 1s linear infinite;
      }
    }
    
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: var(--text-muted);
      
      .material-icons {
        font-size: 64px;
        margin-bottom: var(--spacing-md);
        opacity: 0.5;
      }
      
      h2 {
        font-size: 24px;
        font-weight: 500;
        margin-bottom: var(--spacing-sm);
        color: var(--text-secondary);
      }
      
      p {
        font-size: 14px;
      }
    }
  `]
})
export class ChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messagesContainer') messagesContainer!: ElementRef;
  @ViewChild('scrollAnchor') scrollAnchor!: ElementRef;
  
  sessionId?: string;
  session?: Session;
  messages: DisplayMessage[] = [];
  agents: AgentConfig[] = [];
  selectedAgentIds: string[] = [];
  orchestrationType = 'sequential';
  
  // File upload state
  uploadedFiles: UploadedFile[] = [];
  uploadingFile?: string; // Name of file currently uploading
  uploadError?: string; // Error message for file upload
  
  isLoading = false;
  isSending = false;
  streamingMessage?: DisplayMessage;
  
  // Message pagination
  private messageContinuationToken?: string;
  hasMoreMessages = false;
  isLoadingOlder = false;
  
  private destroy$ = new Subject<void>();
  private shouldScroll = false;
  /** Epoch ms until which ngAfterViewChecked should keep forcing scroll-to-bottom.
   *  Used to handle late layout (e.g. wizard form mount, image decode, font swap)
   *  that happens AFTER the initial post-stream scroll has fired. */
  private pinToBottomUntil = 0;
  private currentPendingId?: string; // Track the pending session ID for this chat
  
  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private chatService: ChatService,
    private agentService: AgentService,
    private sessionState: SessionStateService,
    private documentService: DocumentService,
    public previewService: HtmlPreviewService
  ) {}
  
  ngOnInit(): void {
    // Load agents
    this.agentService.loadAgents()
      .pipe(takeUntil(this.destroy$))
      .subscribe(response => {
        this.agents = response.agents;
        // Ensure there is always at least one selected orchestrator.
        if (this.selectedAgentIds.length === 0) {
          this.ensureOrchestratorSelected();
        }
        // If we already have a session loaded, ensure at least one orchestrator is included.
        if (this.sessionId && this.selectedAgentIds.length > 0) {
          this.ensureOrchestratorSelected();
        }
      });
    
    // Watch for route changes
    this.route.params.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const newSessionId = params['sessionId'];
      const preservePreview = !!newSessionId && this.previewService.consumeRoutePreservation();
      
      // Clear state when switching sessions or starting new chat
      if (this.sessionId !== newSessionId) {
        if (!preservePreview) {
          this.previewService.clear();
        }
        this.messages = [];
        this.session = undefined;
        this.streamingMessage = undefined;
        this.isSending = false;
        this.uploadedFiles = [];
        this.uploadingFile = undefined;
        this.uploadError = undefined;
      }
      
      this.sessionId = newSessionId;
      if (this.sessionId) {
        this.loadSession();
      }
    });
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    } else if (Date.now() < this.pinToBottomUntil) {
      // Late layout window: keep snapping to the bottom as long as the
      // container's content keeps growing (wizard form mount, etc.).
      this.scrollToBottom();
    }
  }
  
  private loadSession(): void {
    if (!this.sessionId) return;
    
    // Check if this is a pending session ID that has been mapped to a real one
    if (this.sessionId.startsWith('pending-')) {
      const realId = this.sessionState.getRealSessionId(this.sessionId);
      if (realId) {
        // Redirect to the real session
        this.sessionState.clearPendingMapping(this.sessionId);
        this.router.navigate(['/chat', realId], { replaceUrl: true });
        return;
      }
      // If no mapping exists, the session hasn't been created yet
      // Just show empty state, don't try to load from backend
      console.log('Pending session not yet saved:', this.sessionId);
      return;
    }
    
    // Check for cached messages (from navigation after stream complete)
    const cachedMessages = this.sessionState.popCachedMessages(this.sessionId);
    if (cachedMessages && cachedMessages.length > 0) {
      console.log('Using cached messages:', cachedMessages.length);
      this.messages = cachedMessages as DisplayMessage[];
      this.isLoading = false;
      // Cached-message replay happens after new-session redirect. The wizard
      // form (if any) mounts in a later CD cycle, so use the same scheduled /
      // pinned scroll the stream-complete path uses.
      this.shouldScroll = true;
      this.scheduleScrollToBottom();
      // Still load session details for the header
      this.chatService.getSession(this.sessionId)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (session) => {
            this.session = session;
            this.selectedAgentIds = session.selectedAgents || [];
            // Ensure at least one orchestrator is included.
            this.ensureOrchestratorSelected();
            this.orchestrationType = session.orchestrationType || 'sequential';
          },
          error: (err) => console.error('Error loading session:', err)
        });
      return;
    }
    
    this.isLoading = true;
    this.messages = []; // Clear previous messages
    
    // Only clear uploaded files if switching to a different session
    // (preserve files if we just created this session and uploaded files to it)
    if (this.session?.id !== this.sessionId) {
      this.uploadedFiles = [];
    }
    
    console.log('Loading session:', this.sessionId);
    
    // Load session details
    this.chatService.getSession(this.sessionId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (session) => {
          console.log('Loaded session details:', session);
          this.session = session;
          this.selectedAgentIds = session.selectedAgents || [];
          // Ensure at least one orchestrator is included.
          this.ensureOrchestratorSelected();
          this.orchestrationType = session.orchestrationType || 'sequential';
          
          // Load documents from session if we don't already have them
          if (session.documents && session.documents.length > 0 && this.uploadedFiles.length === 0) {
            this.uploadedFiles = session.documents.map(doc => ({
              document: {
                id: doc.id,
                sessionId: session.id,
                title: doc.title,
                fileType: doc.fileType,
                sizeBytes: doc.sizeBytes,
                uploadedAt: doc.uploadedAt,
                chunksCount: doc.chunksCount
              }
            }));
            console.log('Loaded documents from session:', this.uploadedFiles.length);
          }
        },
        error: (err) => {
          console.error('Error loading session:', err);
        }
      });
    
    // Load messages (newest first, then reverse for chronological display)
    this.chatService.getMessages(this.sessionId, 50)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          console.log('Loaded messages:', response.messages?.length || 0);
          // Messages come back newest-first (DESC), reverse for chronological display
          this.messages = (response.messages as DisplayMessage[]).reverse().map(m => this.hydrateChatter(m));
          this.messageContinuationToken = response.continuationToken;
          this.hasMoreMessages = response.hasMore;
          this.isLoading = false;
          this.shouldScroll = true;
        },
        error: (err) => {
          console.error('Error loading messages:', err);
          this.isLoading = false;
        }
      });
  }
  
  /** Load older messages (previous page) and prepend to the top */
  loadOlderMessages(): void {
    if (!this.sessionId || !this.messageContinuationToken || this.isLoadingOlder) return;
    
    this.isLoadingOlder = true;
    
    // Save current scroll height to restore position after prepend
    const container = this.messagesContainer.nativeElement;
    const previousScrollHeight = container.scrollHeight;
    
    this.chatService.getMessages(this.sessionId, 50, this.messageContinuationToken)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          // Older messages come back newest-first (DESC), reverse for chronological order
          const olderMessages = (response.messages as DisplayMessage[]).reverse().map(m => this.hydrateChatter(m));
          this.messages = [...olderMessages, ...this.messages];
          this.messageContinuationToken = response.continuationToken;
          this.hasMoreMessages = response.hasMore;
          this.isLoadingOlder = false;
          
          // Preserve scroll position: after DOM updates, adjust scroll so user stays where they were
          requestAnimationFrame(() => {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - previousScrollHeight;
          });
        },
        error: (err) => {
          console.error('Error loading older messages:', err);
          this.isLoadingOlder = false;
        }
      });
  }
  
  /** Ensures at least one orchestrator agent is in selectedAgentIds. */
  private ensureOrchestratorSelected(): void {
    const hasSelectedOrchestrator = this.selectedAgentIds.some(id => this.isOrchestratorId(id));
    if (hasSelectedOrchestrator) {
      return;
    }

    const orchestrator = this.agents.find(a => a.is_orchestrator && a.id);
    if (orchestrator?.id) {
      this.selectedAgentIds = [orchestrator.id, ...this.selectedAgentIds];
    }
  }

  private isOrchestratorId(agentId: string): boolean {
    return this.agents.some(agent => agent.id === agentId && agent.is_orchestrator);
  }
  
  /** Get the full agent configs for selected agent IDs */
  getSelectedAgents(): AgentConfig[] {
    // Sort: orchestrator first, then by name
    return this.agents
      .filter(a => a.id && this.selectedAgentIds.includes(a.id))
      .sort((a, b) => {
        if (a.is_orchestrator && !b.is_orchestrator) return -1;
        if (!a.is_orchestrator && b.is_orchestrator) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
  }

  selectedAgentIdsWithStructuredInputForm(): string[] {
    return this.getSelectedAgents()
      .filter(agent => !!agent.id && !!agent.ui_capabilities?.structured_input_form)
      .map(agent => agent.id!);
  }
  
  /** IDs of selected agents that have document grounding configured */
  get groundedAgentIds(): string[] {
    return this.agents
      .filter(a => a.id && this.selectedAgentIds.includes(a.id)
        && (a.has_grounding || (a.grounding_sources && a.grounding_sources.length > 0)))
      .map(a => a.id!);
  }

  getTokenUsageSummary(): TokenUsageSummary | null {
    const source = this.getTokenUsageSourceMessage();
    const events = source?.chatterEvents || [];
    const usageEvents = events.filter(event => (event.tokensInput || 0) > 0 || (event.tokensOutput || 0) > 0);
    if (usageEvents.length === 0) {
      return null;
    }

    const input = usageEvents.reduce((sum, event) => sum + (event.tokensInput || 0), 0);
    const output = usageEvents.reduce((sum, event) => sum + (event.tokensOutput || 0), 0);
    const total = input + output;
    const byAgent = new Map<string, { input: number; output: number; total: number }>();

    for (const event of usageEvents) {
      const agentName = event.agentName || 'Agent';
      const current = byAgent.get(agentName) || { input: 0, output: 0, total: 0 };
      current.input += event.tokensInput || 0;
      current.output += event.tokensOutput || 0;
      current.total += (event.tokensInput || 0) + (event.tokensOutput || 0);
      byAgent.set(agentName, current);
    }

    const agentBreakdown: TokenAgentBreakdown[] = [...byAgent.entries()]
      .map(([name, value]) => ({
        name,
        input: value.input,
        output: value.output,
        total: value.total,
        percent: total > 0 ? (value.total / total) * 100 : 0,
      }))
      .sort((left, right) => right.total - left.total);

    return {
      label: source === this.streamingMessage ? 'Current response' : 'Last response',
      input,
      output,
      total,
      llmCalls: usageEvents.length,
      agentBreakdown,
    };
  }

  toggleAgent(agentId: string): void {
    const agent = this.agents.find(a => a.id === agentId);
    if (!agent?.id) {
      return;
    }

    const isSelected = this.selectedAgentIds.includes(agentId);

    if (agent.is_orchestrator) {
      if (isSelected) {
        const remainingSelected = this.selectedAgentIds.filter(id => id !== agentId);
        const hasAnotherOrchestrator = remainingSelected.some(id => this.isOrchestratorId(id));
        if (!hasAnotherOrchestrator) {
          return;
        }
        this.selectedAgentIds = remainingSelected;
        return;
      }

      const nonOrchestrators = this.selectedAgentIds.filter(id => !this.isOrchestratorId(id));
      this.selectedAgentIds = [agentId, ...nonOrchestrators];
      return;
    }

    if (!isSelected) {
      this.selectedAgentIds = [...this.selectedAgentIds, agentId];
    } else {
      this.selectedAgentIds = this.selectedAgentIds.filter(id => id !== agentId);
    }
  }
  
  // ── HTML Preview Panel ──
  closePreview(): void {
    this.previewService.close();
  }

  approvePreview(): void {
    this.previewService.close();
    this.sendMessage(
      'The current HTML preview is approved. Continue with the next appropriate step for this task. If publishing, saving, or deployment is part of the workflow, you may proceed.',
      {
        sourceAgentId: this.previewService.previewContext.sourceAgentId,
        sourceAgentName: this.previewService.previewContext.sourceAgentName,
        action: 'approval',
        currentHtml: this.previewService.previewContext.currentHtml,
      }
    );
  }

  sendPreviewFeedback(feedback: string): void {
    this.sendMessage(
      `Revise the current HTML draft directly and return a complete updated page in a new html_preview block. Do not explain the change or provide a partial snippet unless I explicitly ask for one. Keep the existing draft as the source of truth and apply this feedback: ${feedback}`,
      {
        sourceAgentId: this.previewService.previewContext.sourceAgentId,
        sourceAgentName: this.previewService.previewContext.sourceAgentName,
        action: 'revision',
        currentHtml: this.previewService.previewContext.currentHtml,
      }
    );
  }

  /** Check if message at index i is the last assistant message (no streaming message active) */
  isLastAssistant(index: number): boolean {
    if (this.streamingMessage) return false;
    if (this.messages[index]?.role !== 'assistant') return false;
    for (let j = index + 1; j < this.messages.length; j++) {
      if (this.messages[j].role === 'assistant') return false;
    }
    return true;
  }

  sendMessage(content: string, previewContext?: { sourceAgentId?: string; sourceAgentName?: string; action?: string; currentHtml?: string }): void {
    if (!content.trim() || this.isSending) return;
    
    this.isSending = true;
    const isNewSession = !this.sessionId;
    
    // Create a pending session for optimistic UI if this is a new chat
    if (isNewSession) {
      const pendingId = 'pending-' + Date.now();
      this.currentPendingId = pendingId; // Store for later mapping
      const title = content.length > 30 ? content.substring(0, 30) + '...' : content;
      
      // Register this stream with the service so it can track completion
      this.sessionState.registerActiveStream(pendingId);
      
      this.sessionState.setPendingSession({
        id: pendingId,
        title: title,
        orchestrationType: this.orchestrationType,
        selectedAgents: this.selectedAgentIds,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        messageCount: 1
      });
    }
    
    // Add user message to display
    const userMessage: DisplayMessage = {
      id: 'temp-' + Date.now(),
      sessionId: this.sessionId || '',
      role: 'user',
      content: content,
      timestamp: new Date().toISOString()
    };
    this.messages = [...this.messages, userMessage];
    this.shouldScroll = true;
    
    // Initialize streaming message
    this.streamingMessage = {
      id: 'streaming',
      sessionId: this.sessionId || '',
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
      agentResponses: [],
      chatterEvents: []
    };
    
    // Send to backend - pass pendingSessionId so ChatService can notify on completion
    const stream$ = this.chatService.sendMessage({
      message: content,
      sessionId: this.sessionId,
      orchestrationType: this.orchestrationType,
      agentIds: this.selectedAgentIds.length > 0 ? this.selectedAgentIds : undefined,
      pendingSessionId: this.currentPendingId,  // This enables ChatService to notify SessionStateService
      previewContext,
    });
    
    // For new sessions, let the stream complete naturally so sidebar gets refreshed
    // For existing sessions, we can cancel on destroy
    const subscription = (isNewSession ? stream$ : stream$.pipe(takeUntil(this.destroy$))).subscribe({
      next: (event: AGUIEvent) => {
        this.handleAGUIEvent(event, isNewSession);
      },
      error: (error) => {
        console.error('Chat error:', error);
        this.isSending = false;
        this.streamingMessage = undefined;
        // Clear pending session on error
        if (isNewSession) {
          this.sessionState.clearPendingSession();
        }
      },
      complete: () => {
        this.isSending = false;
        if (this.streamingMessage) {
          // Convert streaming message to regular message
          this.messages = [...this.messages, {
            ...this.streamingMessage,
            isStreaming: false
          }];
          this.streamingMessage = undefined;
        }
        // The wizard form (if any) only renders once isStreaming flips to
        // false, which can grow the chat container AFTER the last mid-stream
        // auto-scroll fires. Schedule several scrolls (next tick + a couple of
        // animation frames + a longer fallback) so we still land at the
        // bottom once the form's layout has settled.
        this.shouldScroll = true;
        this.scheduleScrollToBottom();
      }
    });
  }
  
  private handleAGUIEvent(event: AGUIEvent, isNewSession: boolean = false): void {
    // Handle session_created CUSTOM event for new sessions
    if (event.type === 'CUSTOM' && event.name === 'session_created' && isNewSession) {
      const newSessionId = event.value?.['session_id'] as string | undefined;
      if (newSessionId) {
        console.log('AG-UI session_created:', newSessionId, 'pendingId:', this.currentPendingId);

        if (this.currentPendingId) {
          const messagesToCache = [...this.messages];
          if (this.streamingMessage) {
            messagesToCache.push({ ...this.streamingMessage, isStreaming: false });
          }
          this.sessionState.completeNewSession(this.currentPendingId, newSessionId, messagesToCache);
          this.currentPendingId = undefined;
        }

        if (!this.sessionId || this.sessionId.startsWith('pending-')) {
          if (this.previewService.isOpen) {
            this.previewService.preserveForNextRouteChange();
          }
          this.sessionId = newSessionId;
          this.router.navigate(['/chat', newSessionId], { replaceUrl: true });
        }
      }
      return;
    }

    // RUN_FINISHED / RUN_ERROR don't need streamingMessage
    if (event.type === 'RUN_FINISHED') {
      // Refresh sidebar for document-titled sessions
      if (this.session?.title?.startsWith('Document:')) {
        this.sessionState.refreshSessions();
      }
      return;
    }

    if (event.type === 'RUN_ERROR') {
      console.error('AG-UI RUN_ERROR:', event.message);
      return;
    }

    if (!this.streamingMessage) return;

    switch (event.type) {
      // --- Orchestration steps ---
      case 'STEP_STARTED': {
        if (!this.streamingMessage.chatterEvents) {
          this.streamingMessage.chatterEvents = [];
        }
        const stepName = event.step_name || '';
        let chatterType: ChatterEvent['type'] = 'thinking';
        let agentName = 'Orchestrator';
        if (stepName.startsWith('delegate:')) {
          chatterType = 'delegation';
          agentName = stepName.slice('delegate:'.length);
        } else if (stepName.startsWith('thinking:')) {
          agentName = stepName.slice('thinking:'.length);
        }

        const existingIndex = [...this.streamingMessage.chatterEvents]
          .reverse()
          .findIndex(e => e.type === chatterType && e.agentName === agentName && !e.content && !e.friendlyMessage);

        if (existingIndex === -1) {
          this.streamingMessage.chatterEvents = [
            ...this.streamingMessage.chatterEvents,
            { type: chatterType, agentName, content: '', timestamp: Date.now() }
          ];
        }
        break;
      }

      case 'STEP_FINISHED':
        // Lifecycle marker only; the richer CUSTOM chatter/content events carry the
        // actual user-visible summary, so avoid adding a generic "Completed" row.
        break;

      // --- Tool calls ---
      case 'TOOL_CALL_START': {
        if (!this.streamingMessage.chatterEvents) {
          this.streamingMessage.chatterEvents = [];
        }
        this.streamingMessage.chatterEvents = [
          ...this.streamingMessage.chatterEvents,
          {
            type: 'tool_call',
            agentName: event.tool_call_name || 'Agent',
            content: '',
            toolName: event.tool_call_name,
            toolCallId: event.tool_call_id,
            timestamp: Date.now(),
          }
        ];
        break;
      }

      case 'TOOL_CALL_ARGS': {
        // Accumulate args on the most recent tool_call event with matching ID
        const events = this.streamingMessage.chatterEvents || [];
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === 'tool_call' && events[i].toolCallId === event.tool_call_id) {
            try {
              events[i].toolArgs = JSON.parse(event.delta || '{}');
            } catch {
              events[i].toolArgs = { raw: event.delta };
            }
            // Trigger change detection
            this.streamingMessage.chatterEvents = [...events];
            break;
          }
        }
        break;
      }

      case 'TOOL_CALL_END':
        // Tool call completed — no UI change needed (result follows)
        break;

      case 'TOOL_CALL_RESULT': {
        if (!this.streamingMessage.chatterEvents) {
          this.streamingMessage.chatterEvents = [];
        }
        const matchingToolCall = [...this.streamingMessage.chatterEvents]
          .reverse()
          .find(e => e.type === 'tool_call' && e.toolCallId === event.tool_call_id);
        this.streamingMessage.chatterEvents = [
          ...this.streamingMessage.chatterEvents,
          {
            type: 'tool_result',
            agentName: matchingToolCall?.agentName || 'Agent',
            content: event.content || '',
            toolName: matchingToolCall?.toolName,
            toolCallId: event.tool_call_id,
            timestamp: Date.now(),
          }
        ];
        break;
      }

      // --- Text message (final response) ---
      case 'TEXT_MESSAGE_START': {
        const assistantName = typeof this.streamingMessage.metadata?.['assistant_agent_name'] === 'string'
          ? this.streamingMessage.metadata['assistant_agent_name'] as string
          : 'Assistant';
        this.streamingMessage.agentResponses = [
          ...(this.streamingMessage.agentResponses || []),
          { agentName: assistantName, content: '' }
        ];
        this.streamingMessage.metadata = { ...(this.streamingMessage.metadata || {}) };
        break;
      }

      case 'TEXT_MESSAGE_CONTENT':
        if (this.streamingMessage.agentResponses && this.streamingMessage.agentResponses.length > 0) {
          const lastResponse = this.streamingMessage.agentResponses[this.streamingMessage.agentResponses.length - 1];
          lastResponse.content += event.delta || '';
        }
        this.streamingMessage.content += event.delta || '';
        break;

      case 'TEXT_MESSAGE_END':
        // Message complete — no additional action
        break;

      // --- Reasoning tokens (chain-of-thought from reasoning models) ---
      case 'REASONING_START': {
        // Start of a reasoning block — create a lightweight placeholder that can be
        // enriched by the corresponding CUSTOM chatter event.
        if (!this.streamingMessage.chatterEvents) {
          this.streamingMessage.chatterEvents = [];
        }
        this.streamingMessage.chatterEvents = [
          ...this.streamingMessage.chatterEvents,
          {
            type: 'reasoning',
            agentName: 'Agent',
            content: '',
            timestamp: Date.now(),
            friendlyMessage: 'Reasoning...',
          }
        ];
        break;
      }

      case 'REASONING_MESSAGE_CONTENT': {
        // Append reasoning text to the most recent reasoning event
        const rEvents = this.streamingMessage.chatterEvents || [];
        for (let i = rEvents.length - 1; i >= 0; i--) {
          if (rEvents[i].type === 'reasoning') {
            rEvents[i].content += event.delta || '';
            this.streamingMessage.chatterEvents = [...rEvents];
            break;
          }
        }
        break;
      }

      case 'REASONING_MESSAGE_START':
      case 'REASONING_MESSAGE_END':
      case 'REASONING_END':
        // Lifecycle events — no additional UI action needed
        break;

      // --- Custom metadata (chatter enrichment + html preview) ---
      case 'CUSTOM': {
        if (event.name === 'chatter' && event.value) {
          this.enrichChatterFromCustom(event.value);
        } else if (event.name === 'assistant_agent' && event.value) {
          this.streamingMessage.metadata = {
            ...(this.streamingMessage.metadata || {}),
            assistant_agent_id: event.value['agent_id'],
            assistant_agent_name: event.value['agent_name'],
          };

          if (this.streamingMessage.agentResponses?.length) {
            const lastResponse = this.streamingMessage.agentResponses[this.streamingMessage.agentResponses.length - 1];
            if (lastResponse && (!lastResponse.agentName || lastResponse.agentName === 'Assistant')) {
              lastResponse.agentName = (event.value['agent_name'] as string) || 'Assistant';
            }
          }
        } else if (event.name === 'html_preview' && event.value?.['html']) {
          this.previewService.show(
            event.value['html'] as string,
            event.value['agent_id'] as string | undefined,
            event.value['agent_name'] as string | undefined,
          );
        }
        break;
      }

      default:
        break;
    }

    this.shouldScroll = true;
  }

  /**
   * Enrich existing chatter events with metadata from CUSTOM("chatter") events.
   * These carry agent_name, friendly_message, duration_ms, tokens, etc.
   */
  private enrichChatterFromCustom(value: Record<string, unknown>): void {
    if (!this.streamingMessage) return;

    if (!this.streamingMessage.chatterEvents) {
      this.streamingMessage.chatterEvents = [];
    }

    const events = this.streamingMessage.chatterEvents;
    const chatterType = value['chatter_type'] as string | undefined;
    const agentName = value['agent_name'] as string | undefined;
    const toolCallId = value['tool_call_id'] as string | undefined;

    // For tool_call/tool_result, match by tool_call_id first.
    if (toolCallId) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].toolCallId === toolCallId) {
          this.applyChatterMetadata(events[i], value);
          this.streamingMessage.chatterEvents = [...events];
          return;
        }
      }
    }

    if (!chatterType) {
      return;
    }

    const typeMap: Record<string, ChatterEvent['type']> = {
      thinking: 'thinking', delegation: 'delegation', content: 'content',
      tool_call: 'tool_call', tool_result: 'tool_result', reasoning: 'reasoning',
    };
    const mappedType = typeMap[chatterType];
    if (!mappedType) {
      return;
    }

    // Match the most recent compatible event. Allow placeholder "Agent" rows to be
    // claimed by the real agent name once metadata arrives.
    for (let i = events.length - 1; i >= 0; i--) {
      const sameType = events[i].type === mappedType;
      const sameAgent = !agentName || events[i].agentName === agentName || events[i].agentName === 'Agent';
      if (sameType && sameAgent) {
        this.applyChatterMetadata(events[i], value);
        this.streamingMessage.chatterEvents = [...events];
        return;
      }
    }

    // If no matching event exists, create one directly from backend metadata.
    const newEvent: ChatterEvent = {
      type: mappedType,
      agentName: agentName || 'Agent',
      content: (value['content'] as string) || '',
      toolName: value['tool_name'] as string | undefined,
      toolCallId: toolCallId,
      timestamp: Date.now(),
    };
    this.applyChatterMetadata(newEvent, value);
    this.streamingMessage.chatterEvents = [...events, newEvent];
  }

  private applyChatterMetadata(target: ChatterEvent, value: Record<string, unknown>): void {
    if (value['friendly_message']) target.friendlyMessage = value['friendly_message'] as string;
    if (value['duration_ms'] != null) target.durationMs = value['duration_ms'] as number;
    if (value['tokens_input'] != null) target.tokensInput = value['tokens_input'] as number;
    if (value['tokens_output'] != null) target.tokensOutput = value['tokens_output'] as number;
    if (value['content']) target.content = value['content'] as string;
    if (value['agent_name']) target.agentName = value['agent_name'] as string;
    if (value['tool_name']) target.toolName = value['tool_name'] as string;
    if (value['render_hint']) target.renderHint = value['render_hint'] as ChatterEvent['renderHint'];
  }

  /**
   * Hydrate chatter events from persisted metadata when loading historical messages.
   * The backend stores chatter_events in message.metadata for assistant messages.
   */
  private hydrateChatter(msg: DisplayMessage): DisplayMessage {
    if (msg.role !== 'assistant' || !msg.metadata?.['chatter_events']) {
      return msg;
    }
    const raw = msg.metadata['chatter_events'] as Array<Record<string, unknown>>;
    if (!Array.isArray(raw) || raw.length === 0) {
      return msg;
    }
    msg.chatterEvents = raw.map(e => ({
      type: (e['type'] as ChatterEvent['type']) || 'thinking',
      agentName: (e['agent_name'] as string) || 'Agent',
      content: (e['content'] as string) || '',
      toolName: e['tool_name'] as string | undefined,
      toolArgs: e['tool_args'] as Record<string, unknown> | undefined,
      timestamp: (e['timestamp'] as number) || 0,
      durationMs: e['duration_ms'] as number | undefined,
      tokensInput: e['tokens_input'] as number | undefined,
      tokensOutput: e['tokens_output'] as number | undefined,
      friendlyMessage: e['friendly_message'] as string | undefined,
      renderHint: e['render_hint'] as ChatterEvent['renderHint'],
    }));
    return msg;
  }

  private getTokenUsageSourceMessage(): DisplayMessage | undefined {
    const streamingHasUsage = !!this.streamingMessage?.chatterEvents?.some(
      event => (event.tokensInput || 0) > 0 || (event.tokensOutput || 0) > 0
    );
    if (streamingHasUsage) {
      return this.streamingMessage;
    }

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role !== 'assistant') continue;
      const hasUsage = !!message.chatterEvents?.some(
        event => (event.tokensInput || 0) > 0 || (event.tokensOutput || 0) > 0
      );
      if (hasUsage) {
        return message;
      }
    }

    return undefined;
  }
  
  handleFileUpload(file: File): void {
    // Clear any previous error
    this.uploadError = undefined;
    
    // Validate file size (10MB limit)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      this.uploadError = 'File too large. Maximum size is 10MB.';
      return;
    }
    
    // Validate file type
    const allowedTypes = ['txt', 'md', 'pdf', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'jpg', 'jpeg', 'png', 'tiff'];
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (!allowedTypes.includes(extension)) {
      this.uploadError = `File type .${extension} not supported. Allowed: ${allowedTypes.join(', ')}`;
      return;
    }
    
    // If no session exists, create one first
    if (!this.sessionId || this.sessionId.startsWith('pending-')) {
      this.uploadingFile = file.name;
      const title = `Document: ${file.name}`;
      
      this.chatService.createSession(title, this.orchestrationType, this.selectedAgentIds)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (session) => {
            // Set session first before navigating
            this.sessionId = session.id;
            this.session = session;
            
            // Upload the file
            this.documentService.uploadDocument(file, session.id).subscribe({
              next: (response) => {
                const uploadedFile: UploadedFile = {
                  document: response.document
                };
                this.uploadedFiles.push(uploadedFile);
                this.uploadingFile = undefined;
                console.log('File uploaded successfully:', response);
              },
              error: (error) => {
                console.error('File upload failed:', error);
                this.uploadError = error.error?.detail || 'Failed to upload file. Please try again.';
                this.uploadingFile = undefined;
              }
            });
            
            // Update URL without triggering route reload
            // Using location.replaceState to just update the URL in browser history
            window.history.replaceState({}, '', `/chat/${session.id}`);
            
            // Trigger sidebar refresh so the new session appears
            this.sessionState.refreshSessions();
          },
          error: (error) => {
            console.error('Failed to create session:', error);
            this.uploadError = 'Failed to create session. Please try again.';
            this.uploadingFile = undefined;
          }
        });
      return;
    }
    
    this.uploadingFile = file.name;
    this.uploadFileToSession(file, this.sessionId);
  }
  
  private uploadFileToSession(file: File, sessionId: string): void {
    this.documentService.uploadDocument(file, sessionId).subscribe({
      next: (response) => {
        const uploadedFile: UploadedFile = {
          document: response.document
        };
        this.uploadedFiles.push(uploadedFile);
        this.uploadingFile = undefined;
        console.log('File uploaded successfully:', response);
      },
      error: (error) => {
        console.error('File upload failed:', error);
        this.uploadError = error.error?.detail || 'Failed to upload file. Please try again.';
        this.uploadingFile = undefined;
      }
    });
  }
  
  removeFile(file: UploadedFile): void {
    this.documentService.deleteDocument(file.document.id).subscribe({
      next: () => {
        this.uploadedFiles = this.uploadedFiles.filter(f => f.document.id !== file.document.id);
        console.log('File removed:', file.document.title);
      },
      error: (error) => {
        console.error('Failed to remove file:', error);
      }
    });
  }
  
  /** Open document content in a new tab */
  openDocument(file: UploadedFile): void {
    this.documentService.fetchDocumentContent(file.document.id).subscribe({
      next: (response) => {
        const blob = response.body;
        if (!blob) {
          return;
        }
        const contentType = response.headers.get('Content-Type') || 'text/plain';
        const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
        window.open(blobUrl, '_blank');
        // Revoke after a delay to allow the new tab to load content.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      },
      error: (error) => {
        console.error('Failed to open document:', error);
        if (error.status === 403) {
          this.uploadError = 'You do not have permission to view this document.';
        } else if (error.status === 404) {
          this.uploadError = 'Document not found.';
        } else {
          this.uploadError = 'Failed to open document. Please try again.';
        }
      }
    });
  }
  
  getFileIcon(fileType: string): string {
    // Return Material Icon names, not emojis
    const icons: { [key: string]: string } = {
      'pdf': 'picture_as_pdf',
      'txt': 'article',
      'md': 'description',
      'json': 'data_object',
      'csv': 'table_chart',
      'docx': 'description',
      'xlsx': 'table_chart',
      'pptx': 'slideshow',
      'jpg': 'image',
      'jpeg': 'image',
      'png': 'image',
      'tiff': 'image'
    };
    return icons[fileType] || 'attach_file';
  }
  
  private scrollToBottom(): void {
    try {
      // Prefer programmatic scroll on the container — it is deterministic
      // even when layout shifts (e.g. the wizard form mounting) would
      // otherwise interrupt a smooth scrollIntoView animation.
      const container = this.messagesContainer?.nativeElement as HTMLElement | undefined;
      if (container) {
        container.scrollTop = container.scrollHeight;
        return;
      }
      this.scrollAnchor.nativeElement.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Scroll error:', err);
    }
  }

  /**
   * Schedule multiple scroll-to-bottom passes so we still end up at the
   * bottom after late layout (e.g. dynamically mounted wizard form fields,
   * images decoding, fonts swapping).
   */
  private scheduleScrollToBottom(): void {
    this.scrollToBottom();
    // Keep ngAfterViewChecked snapping to the bottom for ~600ms so the
    // wizard form mounting in a later change-detection cycle still scrolls.
    this.pinToBottomUntil = Date.now() + 600;
    requestAnimationFrame(() => {
      this.scrollToBottom();
      requestAnimationFrame(() => this.scrollToBottom());
    });
    setTimeout(() => this.scrollToBottom(), 100);
    setTimeout(() => this.scrollToBottom(), 300);
    setTimeout(() => this.scrollToBottom(), 600);
  }
}
