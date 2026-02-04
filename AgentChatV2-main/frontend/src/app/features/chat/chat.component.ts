import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';

import { ChatService, Message, Session, StreamChunk } from '../../core/services/chat.service';
import { AgentService, AgentConfig } from '../../core/services/agent.service';
import { SessionStateService } from '../../core/services/session-state.service';
import { DocumentService, DocumentMetadata } from '../../core/services/document.service';
import { MessageComponent } from './components/message/message.component';
import { ChatInputComponent } from './components/chat-input/chat-input.component';
import { AgentSelectorComponent } from './components/agent-selector/agent-selector.component';

// Chatter event for displaying agent thought process
export interface ChatterEvent {
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

// UploadedFile wraps document response with UI state
interface UploadedFile {
  document: DocumentMetadata;
  isUploading?: boolean;
  error?: string;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    FormsModule,
    MessageComponent,
    ChatInputComponent,
    AgentSelectorComponent
  ],
  template: `
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
        @if (messages.length === 0 && !isLoading) {
          <div class="empty-state">
            <span class="material-icons">forum</span>
            <h2>Start a conversation</h2>
            <p>Select agents and type your message below to begin.</p>
          </div>
        }
        
        @for (message of messages; track message.id) {
          <app-message 
            [message]="message"
            [isStreaming]="message.isStreaming ?? false"
          ></app-message>
        }
        
        @if (streamingMessage) {
          <app-message 
            [message]="streamingMessage"
            [isStreaming]="true"
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
                <span class="file-info">{{ file.document.chunksCount }} chunks</span>
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
        (send)="sendMessage($event)"
        (fileUpload)="handleFileUpload($event)"
      ></app-chat-input>
    </div>
  `,
  styles: [`
    .chat-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px);
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
  
  private destroy$ = new Subject<void>();
  private shouldScroll = false;
  private currentPendingId?: string; // Track the pending session ID for this chat
  
  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private chatService: ChatService,
    private agentService: AgentService,
    private sessionState: SessionStateService,
    private documentService: DocumentService
  ) {}
  
  ngOnInit(): void {
    // Load agents
    this.agentService.loadAgents()
      .pipe(takeUntil(this.destroy$))
      .subscribe(response => {
        this.agents = response.agents;
        // Select orchestrator by default if no agents selected yet
        const orchestrator = this.agents.find(a => a.is_orchestrator);
        if (orchestrator && orchestrator.id && this.selectedAgentIds.length === 0) {
          this.selectedAgentIds = [orchestrator.id];
        }
        // If we already have a session loaded, ensure orchestrator is included
        if (this.sessionId && this.selectedAgentIds.length > 0) {
          this.ensureOrchestratorSelected();
        }
      });
    
    // Watch for route changes
    this.route.params.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const newSessionId = params['sessionId'];
      
      // Clear state when switching sessions or starting new chat
      if (this.sessionId !== newSessionId) {
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
      this.shouldScroll = true;
      // Still load session details for the header
      this.chatService.getSession(this.sessionId)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (session) => {
            this.session = session;
            this.selectedAgentIds = session.selectedAgents || [];
            // Ensure orchestrator is always included
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
          // Ensure orchestrator is always included
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
    
    // Load messages
    this.chatService.getMessages(this.sessionId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          console.log('Loaded messages:', response.messages?.length || 0);
          this.messages = response.messages as DisplayMessage[];
          this.isLoading = false;
          this.shouldScroll = true;
        },
        error: (err) => {
          console.error('Error loading messages:', err);
          this.isLoading = false;
        }
      });
  }
  
  /** Ensures the orchestrator agent is always in selectedAgentIds */
  private ensureOrchestratorSelected(): void {
    const orchestrator = this.agents.find(a => a.is_orchestrator);
    if (orchestrator?.id && !this.selectedAgentIds.includes(orchestrator.id)) {
      this.selectedAgentIds = [orchestrator.id, ...this.selectedAgentIds];
    }
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
  
  toggleAgent(agentId: string): void {
    // Find if this is the orchestrator - orchestrator cannot be unchecked
    const agent = this.agents.find(a => a.id === agentId);
    if (agent?.is_orchestrator) {
      return; // Orchestrator is always selected
    }
    
    const index = this.selectedAgentIds.indexOf(agentId);
    if (index === -1) {
      this.selectedAgentIds = [...this.selectedAgentIds, agentId];
    } else {
      this.selectedAgentIds = this.selectedAgentIds.filter(id => id !== agentId);
    }
  }
  
  sendMessage(content: string): void {
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
      pendingSessionId: this.currentPendingId  // This enables ChatService to notify SessionStateService
    });
    
    // For new sessions, let the stream complete naturally so sidebar gets refreshed
    // For existing sessions, we can cancel on destroy
    const subscription = (isNewSession ? stream$ : stream$.pipe(takeUntil(this.destroy$))).subscribe({
      next: (chunk: StreamChunk) => {
        this.handleStreamChunk(chunk, isNewSession);
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
      }
    });
  }
  
  private handleStreamChunk(chunk: StreamChunk, isNewSession: boolean = false): void {
    // For new sessions, always handle the done chunk even if streamingMessage is gone
    // (user may have navigated away)
    // Note: Backend sends session_id at top level, not in metadata
    if (chunk.type === 'done' && isNewSession && chunk.session_id) {
      const newSessionId = chunk.session_id;
      console.log('Stream done for new session:', newSessionId, 'pendingId:', this.currentPendingId);
      
      // Use the service to handle all cleanup - this works even if component is navigated away
      if (this.currentPendingId) {
        const messagesToCache = [...this.messages];
        if (this.streamingMessage) {
          messagesToCache.push({
            ...this.streamingMessage,
            isStreaming: false
          });
        }
        
        // This method handles: mapping, caching messages, clearing pending, refreshing sidebar
        this.sessionState.completeNewSession(this.currentPendingId, newSessionId, messagesToCache);
        this.currentPendingId = undefined;
      }
      
      // Only navigate if we're still on the new chat page or pending session
      if (!this.sessionId || this.sessionId.startsWith('pending-')) {
        this.sessionId = newSessionId;
        this.router.navigate(['/chat', newSessionId], { replaceUrl: true });
      }
      return;
    }
    
    if (!this.streamingMessage) return;
    
    switch (chunk.type) {
      case 'chatter':
        // Add chatter event to streaming message
        if (!this.streamingMessage.chatterEvents) {
          this.streamingMessage.chatterEvents = [];
        }
        const chatterEvent: ChatterEvent = {
          type: chunk.chatter_type || 'thinking',
          agentName: chunk.agent_name || 'Agent',
          content: chunk.content || '',
          toolName: chunk.tool_name,
          toolArgs: chunk.tool_args,
          timestamp: Date.now(),
          durationMs: chunk.duration_ms,
          tokensInput: chunk.tokens_input,
          tokensOutput: chunk.tokens_output,
          friendlyMessage: chunk.friendly_message
        };
        this.streamingMessage.chatterEvents = [
          ...this.streamingMessage.chatterEvents,
          chatterEvent
        ];
        break;
        
      case 'agent_start':
        // New agent is responding
        this.streamingMessage.agentResponses = [
          ...(this.streamingMessage.agentResponses || []),
          { agentName: chunk.agentName || 'Agent', content: '' }
        ];
        break;
        
      case 'content':
        // Add content
        if (this.streamingMessage.agentResponses && this.streamingMessage.agentResponses.length > 0) {
          const lastResponse = this.streamingMessage.agentResponses[this.streamingMessage.agentResponses.length - 1];
          lastResponse.content += chunk.content || '';
        }
        this.streamingMessage.content += chunk.content || '';
        break;
        
      case 'done':
        // New session done handling is done above, this is for follow-up messages
        // Refresh sidebar in case session title was updated (e.g., from "Document:" to question)
        if (this.session?.title?.startsWith('Document:')) {
          this.sessionState.refreshSessions();
        }
        break;
        
      case 'error':
        console.error('Stream error:', chunk.content);
        break;
    }
    
    this.shouldScroll = true;
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
    const allowedTypes = ['txt', 'md', 'pdf', 'json', 'csv'];
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
    const url = this.documentService.getDocumentContentUrl(file.document.id);
    window.open(url, '_blank');
  }
  
  getFileIcon(fileType: string): string {
    // Return Material Icon names, not emojis
    const icons: { [key: string]: string } = {
      'pdf': 'picture_as_pdf',
      'txt': 'article',
      'md': 'description',
      'json': 'data_object',
      'csv': 'table_chart'
    };
    return icons[fileType] || 'attach_file';
  }
  
  private scrollToBottom(): void {
    try {
      this.scrollAnchor.nativeElement.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error('Scroll error:', err);
    }
  }
}
