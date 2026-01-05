import { Component, inject, OnInit, signal, ViewChild, ElementRef, AfterViewChecked, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatListModule } from '@angular/material/list';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatMenuModule } from '@angular/material/menu';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ChatService } from '../services/chat.service';
import { OpenAIService } from '../services/openai.service';
import { DocumentService } from '../services/document.service';
import { AuthService } from '../services/auth.service';
import { AgentActivityComponent } from './agent-activity.component';
import { McpToolsDialogComponent } from './mcp-tools-dialog.component';
import { environment } from '../../environments/environment';
import { ChatMessage } from '../models/chat.models';
import { v4 as uuidv4 } from 'uuid';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatListModule,    MatSidenavModule,
    MatToolbarModule,    MatMenuModule,    MatChipsModule,
    MatTooltipModule,
    MatDialogModule,
    AgentActivityComponent
  ],
  template: `
    <div class="chat-container">
      <!-- Sidebar -->
      <mat-sidenav-container class="sidenav-container">        <mat-sidenav #sidenav mode="side" opened class="sidebar">
          <div class="sidebar-header">
            <!-- User info moved to chat-header -->
            
            <button mat-icon-button (click)="createNewChat()" class="new-chat-btn">
              <mat-icon>add</mat-icon>              New Chat
            </button>
            
            <!-- MCP Status -->
            <div class="mcp-status">
              @if (chatService.mcpEnabled()) {
                <mat-chip color="primary" (click)="openMcpToolsDialog()" class="clickable-chip">
                  <mat-icon>extension</mat-icon>
                  MCP Tools ({{ chatService.availableTools().length }})
                </mat-chip>
              } @else {
                <mat-chip color="warn">
                  <mat-icon>extension_off</mat-icon>
                  MCP Offline
                </mat-chip>
              }
            </div>
          </div>          <div class="chat-history" (scroll)="onSessionsScroll($event)" #sessionsContainer>
            <mat-list>
              @for (session of chatService.sessions(); track session.id) {
                <mat-list-item 
                  [class.active]="chatService.currentSession()?.id === session.id">
                  <div class="session-item">
                    <span class="session-title" (click)="loadChatSession(session.id)">{{ session.title }}</span>
                    <button (click)="deleteSession(session.id); $event.stopPropagation()" class="delete-btn" matTooltip="Delete chat">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </div>
                </mat-list-item>
              }
              @if (chatService.isLoadingSessions()) {
                <div class="loading-indicator">
                  <mat-spinner diameter="30"></mat-spinner>
                  <span>Loading more sessions...</span>
                </div>
              }
            </mat-list>
          </div><div class="sidebar-footer">
            <!-- User info moved to sidebar-header -->
          </div>
        </mat-sidenav>        <!-- Main Chat Area -->
        <mat-sidenav-content class="main-content">
          <div class="content-layout">
            <!-- Chat Section -->
            <div class="chat-section">
              <div class="chat-header">
                <button mat-icon-button (click)="sidenav.toggle()">
                  <mat-icon>menu</mat-icon>
                </button>                <h2>{{ chatService.currentSession()?.title || 'Rude Chat' }}</h2>
                
                <!-- User Info moved here -->
                <div class="user-info" *ngIf="authService.getUser() as user">
                  <mat-icon>account_circle</mat-icon>
                  <span>{{ user.name }}</span>
                  <button mat-icon-button [matMenuTriggerFor]="userMenu">
                    <mat-icon>more_vert</mat-icon>
                  </button>
                  <mat-menu #userMenu="matMenu">
                    <button mat-menu-item (click)="authService.logout()">
                      <mat-icon>logout</mat-icon>
                      Logout
                    </button>
                  </mat-menu>
                </div>
              </div><!-- Uploaded Documents -->
          @if (uploadedDocuments().length > 0) {
            <div class="documents-section">
              <div class="documents-header">
                <mat-icon>description</mat-icon>
                <span>Uploaded Documents</span>
                @if (chatService.ragActive()) {
                  <mat-icon class="rag-active-icon">search</mat-icon>
                  <span class="rag-status">RAG Active</span>
                }
              </div>              <mat-chip-listbox>
                @for (doc of uploadedDocuments(); track doc.documentId) {
                  <mat-chip (removed)="removeDocument(doc.documentId)">
                    <span class="document-link" (click)="viewDocument(doc)" title="Click to view document">{{ doc.fileName }}</span>
                    <button matChipRemove>
                      <mat-icon>cancel</mat-icon>
                    </button>
                  </mat-chip>
                }
              </mat-chip-listbox>
            </div>
          }          <!-- Messages -->
          <div class="messages-container" #messagesContainer (scroll)="onMessagesScroll($event)">
            @if (chatService.isLoadingMessages()) {
              <div class="loading-indicator loading-messages">
                <mat-spinner diameter="24"></mat-spinner>
                <span>Loading older messages...</span>
              </div>
            }
            @for (message of chatService.messages$ | async; track message.id) {
              <div class="message" [class]="'message-' + message.role">
                <div class="message-avatar">
                  <mat-icon>{{ message.role === 'user' ? 'person' : 'smart_toy' }}</mat-icon>
                </div>                <div class="message-content">
                  <div class="message-text" [innerHTML]="formatMessageContent(message.content)"></div>                  @if (hasMapUrl(message.content)) {
                    <div class="map-container">
                      @if (getMapImageBlob(message.content) && getMapImageBlob(message.content) !== 'error') {
                        <img 
                          [src]="getMapImageBlob(message.content)"
                          alt="Map"
                          class="map-image"
                          (error)="onMapLoadError($event)"
                          loading="lazy"
                        />
                      } @else if (getMapImageBlob(message.content) === 'error') {
                        <div class="map-error">
                          <mat-icon>error_outline</mat-icon>
                          <p>Failed to load map image</p>
                          <small>{{extractMapUrl(message.content)}}</small>
                        </div>
                      } @else {
                        <div class="map-loading">
                          <mat-spinner diameter="20"></mat-spinner>
                          <p>Loading map...</p>
                        </div>
                      }
                      <div class="map-caption">
                        <mat-icon>map</mat-icon>
                        Interactive Map
                      </div>
                    </div>
                  }
                  @if (message.isLoading) {
                    <mat-spinner diameter="20"></mat-spinner>
                  }@if (message.metadata && message.metadata.sources && message.metadata.sources.length > 0) {
                    <div class="message-sources">
                      <h4>Sources:</h4>
                      @for (source of message.metadata.sources; track source.id) {
                        <div class="source-item">
                          <strong>{{ source.title }}</strong>
                          <p>{{ source.content.substring(0, 200) }}...</p>
                        </div>
                      }
                    </div>
                  }
                </div>
              </div>
            }
            
            @if (chatService.isTyping()) {
              <div class="message message-assistant">
                <div class="message-avatar">
                  <mat-icon>smart_toy</mat-icon>
                </div>
                <div class="message-content">
                  <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            }
          </div>          
          <!-- Research Controls (shown when research is active) -->
          @if (chatService.agentActivityService.isResearchActive()) {
            <div class="research-controls">
              <div class="research-status">
                <mat-icon>science</mat-icon>
                <span>{{ pausingResearch() ? 'Pause requested, generating summary...' : 'Deep research in progress...' }}</span>
              </div>
              <div class="control-buttons">
                <button 
                  mat-raised-button 
                  color="warn"
                  (click)="pauseAndSummarize()"
                  [disabled]="pausingResearch()"
                  matTooltip="Stop research and generate progress summary">
                  @if (pausingResearch()) {
                    <mat-spinner diameter="20" style="display: inline-block; margin-right: 8px;"></mat-spinner>
                  } @else {
                    <mat-icon>pause</mat-icon>
                  }
                  {{ pausingResearch() ? 'Generating Summary...' : 'Pause & Summarize' }}
                </button>
              </div>
            </div>
          }
          
          <!-- Input Area -->
          <div class="input-container">
            <div class="message-input-wrapper">
              <mat-form-field class="message-input" appearance="outline">
                <textarea 
                  matInput 
                  [(ngModel)]="messageText" 
                  placeholder="Type your message..." 
                  (keydown.enter)="onEnterPressed($any($event))"
                  [disabled]="chatService.isTyping()"
                  rows="3"
                  #messageInput></textarea>
              </mat-form-field>
              
              <!-- Attach icon positioned absolutely -->
              <mat-icon class="attach-icon" (click)="fileInput.click()" 
                       matTooltip="Upload Document">attach_file</mat-icon>
              <input #fileInput type="file" hidden (change)="onFileSelected($event)" 
                     accept=".pdf,.doc,.docx,.txt,.md">
            </div>
              <button 
              mat-fab 
              color="primary" 
              (click)="sendMessage()" 
              [disabled]="!messageText.trim() || chatService.isTyping()"
              class="send-button">
              <mat-icon>send</mat-icon>
            </button>
            
            <!-- SSE Test Button -->
            <!-- <button 
              mat-mini-fab 
              color="warn" 
              (click)="testSSE()" 
              class="test-sse-button"
              title="Test SSE agentActivity Event">
              <mat-icon>bug_report</mat-icon>
            </button> -->
          </div>
        </div> <!-- End chat-section -->
          <!-- Agent Activity Panel -->
        <div class="agent-panel">
          <app-agent-activity></app-agent-activity>
        </div>
      </div> <!-- End content-layout -->
    </mat-sidenav-content>
  </mat-sidenav-container>
</div>
  `,
  styleUrl: './chat.component.scss'
})
export class ChatComponent implements OnInit, AfterViewChecked {
  @ViewChild('messagesContainer') messagesContainer!: ElementRef;
  @ViewChild('messageInput') messageInput!: ElementRef;
  @ViewChild('sessionsContainer') sessionsContainer!: ElementRef;

  chatService = inject(ChatService);
  openAIService = inject(OpenAIService);
  documentService = inject(DocumentService);
  authService = inject(AuthService);

  http = inject(HttpClient);
  cdr = inject(ChangeDetectorRef);  dialog = inject(MatDialog);  messageText = '';
  uploadedDocuments = signal<any[]>([]);
  mapImageCache = new Map<string, string>(); // Cache for blob URLs
  
  // Research control signals
  isResearchActive = signal<boolean>(false);
  showResearchControls = signal<boolean>(false);

  private shouldAutoScroll = true; // Track if we should auto-scroll
  private lastMessageCount = 0; // Track message count for auto-scroll logic
  async ngOnInit() {
    // console.log('ChatComponent ngOnInit started');
    
    // Load saved sessions from backend
    await this.chatService.loadSessions();
    // console.log('Sessions loaded:', this.chatService.sessions().length);
    
    // Create initial chat session if none exists
    if (!this.chatService.currentSession()) {
      await this.createNewChat();
    }
    
    // Always check for current session and load documents after loadSessions completes
    // This ensures documents are loaded whether session was auto-selected or already existed
    const currentSession = this.chatService.currentSession();
    if (currentSession) {
      // console.log('Loading documents for current session:', currentSession.id);
      await this.loadSessionDocuments(currentSession.id);
    }
    
    // console.log('ChatComponent ngOnInit completed');
  }
  ngAfterViewChecked() {
    // Only auto-scroll if we should and there are new messages
    const currentSession = this.chatService.currentSession();
    if (currentSession && currentSession.messages.length > this.lastMessageCount) {
      if (this.shouldAutoScroll) {
        this.scrollToBottom();
      }
      this.lastMessageCount = currentSession.messages.length;
    }
  }  async createNewChat() {
    try {
      const newSession = await this.chatService.createNewSession();
      // console.log('Created new session:', newSession.id);
      // For new sessions, start with empty documents
      this.uploadedDocuments.set([]);
      this.messageText = '';
      // Reset research control states for new session
      this.pausingResearch.set(false);
      this.showResearchControls.set(false);
    } catch (error) {
      console.error('Error creating new chat:', error);
    }
  }async loadChatSession(sessionId: string) {
    try {
      await this.chatService.loadSession(sessionId);
      // Load documents for this session
      await this.loadSessionDocuments(sessionId);
      // Reset research control states when switching sessions
      this.pausingResearch.set(false);
      this.showResearchControls.set(false);
      // Reset auto-scroll for new session and scroll to bottom
      this.shouldAutoScroll = true;
      this.lastMessageCount = 0;
      setTimeout(() => this.scrollToBottom(), 100); // Delay to ensure DOM is updated
    } catch (error) {
      console.error('Error loading chat session:', error);
    }
  }
  async loadSessionDocuments(sessionId: string) {
    try {
      // console.log('Loading documents for session:', sessionId);
      const documents$ = await this.documentService.getDocuments(sessionId);
      documents$.subscribe({
        next: (docs) => {
          // console.log('Documents loaded:', docs);
          this.uploadedDocuments.set(docs);
        },
        error: (error) => {
          console.error('Error in documents subscription:', error);
        }
      });
    } catch (error) {
      console.error('Error loading documents:', error);
    }
  }
  async deleteSession(sessionId: string) {
    // Find the session to get its title
    const session = this.chatService.sessions().find(s => s.id === sessionId);
    const sessionTitle = session?.title || 'this chat';
    
    // Show confirmation dialog
    const confirmed = confirm(`Are you sure you want to delete "${sessionTitle}"? This action cannot be undone.`);
    
    if (confirmed) {
      try {
        await this.chatService.deleteSession(sessionId);
      } catch (error) {
        console.error('Error deleting session:', error);
        alert('Failed to delete the chat session. Please try again.');
      }
    }
  }
  async onFileSelected(event: any) {
    const file = event.target.files[0];
    if (!file) return;

    const currentSession = this.chatService.currentSession();
    if (!currentSession) return;

    try {
      const upload$ = await this.documentService.uploadDocument(file, currentSession.id);      upload$.subscribe(uploadResponse => {
        // Keep the backend response properties as-is
        const uploadedDoc = {
          documentId: uploadResponse.documentId,
          fileName: uploadResponse.fileName,
          status: uploadResponse.status,
          userId: uploadResponse.userId,
          sessionId: uploadResponse.sessionId,
          uploadDate: uploadResponse.uploadDate,
          fileSize: uploadResponse.fileSize,
          blobUrl: uploadResponse.blobUrl
        };
        
        const current = this.uploadedDocuments();
        this.uploadedDocuments.set([...current, uploadedDoc]);
        
        // Clear the file input
        event.target.value = '';
      });
    } catch (error) {
      console.error('Error uploading document:', error);
    }
  }
  async removeDocument(documentId: string) {
    try {
      const delete$ = await this.documentService.deleteDocument(documentId);
      delete$.subscribe(() => {
        const current = this.uploadedDocuments();
        this.uploadedDocuments.set(current.filter(doc => doc.documentId !== documentId));
      });
    } catch (error) {
      console.error('Error deleting document:', error);
    }
  }

  onEnterPressed(event: KeyboardEvent) {
    if (event.shiftKey) {
      return; // Allow line break with Shift+Enter
    }
    event.preventDefault();
    this.sendMessage();
  }
  async sendMessage() {
    if (!this.messageText.trim()) return;

    const userInput = this.messageText;
    this.messageText = '';

    // Enable auto-scroll for new messages
    this.shouldAutoScroll = true;

    // Use the ChatService sendMessage method
    await this.chatService.sendMessage(userInput);
  }

  async testSSE() {
    console.log('🧪 Testing SSE agentActivity event...');
    
    const currentSessionId = this.chatService.currentSession()?.id;
    if (!currentSessionId) {
      console.warn('⚠️ No active session for SSE test');
      return;
    }

    try {
      const response = await this.http.post(`${environment.api.baseUrl}/test/activity/${currentSessionId}`, {}).toPromise();
      console.log('✅ SSE test trigger response:', response);
    } catch (error) {
      console.error('❌ Error triggering SSE test:', error);
    }
  }

  pausingResearch = signal<boolean>(false);

  async pauseAndSummarize() {
    const sessionId = this.chatService.currentSession()?.id;
    if (!sessionId) return;

    this.pausingResearch.set(true);

    try {
      const response = await this.http.post<{success: boolean}>(`${environment.api.baseUrl}/research/pause`, {
        sessionId
      }).toPromise();

      if (response?.success) {
        console.log('✅ Research pause requested - waiting for summary generation');
        // Don't hide controls or clear loading state - wait for the actual summary message to arrive
        // The summary will be displayed as a regular chat message
      }
    } catch (error) {
      console.error('Error pausing research:', error);
      alert('Failed to pause research. Please try again.');
      this.pausingResearch.set(false);
      this.showResearchControls.set(false);
    }
    // Note: We do NOT clear pausingResearch here - it stays true until the summary actually arrives
    // The button will re-enable when the research controls auto-hide after receiving the paused message
  }

  openMcpToolsDialog() {
    this.dialog.open(McpToolsDialogComponent, {
      width: '90vw',
      maxWidth: '1000px',
      maxHeight: '90vh',
      panelClass: 'mcp-tools-dialog-container'
    });
  }
  
  private scrollToBottom() {
    try {
      if (this.messagesContainer) {
        this.messagesContainer.nativeElement.scrollTop = 
          this.messagesContainer.nativeElement.scrollHeight;
      }
    } catch (err) {
      console.error('Error scrolling to bottom:', err);
    }
  }  // Map URL detection and formatting methods
  hasMapUrl(content: string): boolean {
    return (content.includes('**Map URL:**') && 
           (content.includes('atlas.microsoft.com/map/static/png') || content.includes('atlas.azure.us/map/static/png'))) ||
           (content.includes('![') && (content.includes('atlas.azure.us/map/static/png') || content.includes('atlas.microsoft.com/map/static/png')));
  }
  extractMapUrl(content: string): string | null {
    // First try the old format (supports both domains)
    const mapUrlRegex = /\*\*Map URL:\*\*\s*(https:\/\/atlas\.(microsoft\.com|azure\.us)\/[^\s\n]+)/;
    const match = content.match(mapUrlRegex);
    if (match) {
      return match[1];
    }

    // Try markdown image format (supports both domains)
    const markdownImageRegex = /!\[.*?\]\((https:\/\/atlas\.(microsoft\.com|azure\.us)\/[^)]+)\)/;
    const markdownMatch = content.match(markdownImageRegex);
    return markdownMatch ? markdownMatch[1] : null;
  }  formatMessageContent(content: string): string {
    // Convert markdown-style formatting to HTML and linkify URLs
    let formatted = content
      // Bold text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1<\/strong>')
      // Italic text (single asterisk)
      .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1<\/em>')
      // Markdown links: [Title](https://example.com)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1<\/a>')
      // Hide map URLs since we display them as images (both formats and domains)
      .replace(/\*\*Map URL:\*\*[^\n]+/g, '')
      .replace(/!\[.*?\]\(https:\/\/atlas\.(microsoft\.com|azure\.us)\/[^)]+\)/g, '')
      // Line breaks
      .replace(/\n/g, '<br>');

    // Preserve existing anchors, then linkify bare URLs safely
    const anchorTagRegex = /<a [^>]*>.*?<\/a>/gi;
    const placeholders: string[] = [];
    formatted = formatted.replace(anchorTagRegex, (match) => {
      placeholders.push(match);
      return `__ANCHOR_PLACEHOLDER_${placeholders.length - 1}__`;
    });

    // Linkify plain http(s) URLs not already inside anchors
    formatted = formatted.replace(/(https?:\/\/[^\s<]+[^<.,:;"')\]\s])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1<\/a>');

    // Restore preserved anchors
    placeholders.forEach((a, i) => {
      formatted = formatted.replace(`__ANCHOR_PLACEHOLDER_${i}__`, a);
    });

    // Clean up multiple consecutive line breaks
    formatted = formatted.replace(/(<br>\s*){3,}/g, '<br><br>');

    return formatted;
  }

  getMapImageBlob(content: string): string | null {
    const mapUrl = this.extractMapUrl(content);
    if (!mapUrl) {
      return null;
    }

    // Check cache first
    if (this.mapImageCache.has(mapUrl)) {
      return this.mapImageCache.get(mapUrl)!;
    }

    // Fetch the image and create blob URL
    this.fetchMapImage(mapUrl);
    return null; // Return null while loading
  }  private async fetchMapImage(mapUrl: string): Promise<void> {
    try {
      console.log('Fetching map image via proxy:', mapUrl);
        // Use the backend proxy to avoid CORS issues
      const proxyUrl = `${environment.api.baseUrl}/map/image?url=${encodeURIComponent(mapUrl)}`;
      
      // Fetch the image as blob via the proxy
      const response = await this.http.get(proxyUrl, { 
        responseType: 'blob',
        headers: {
          'Accept': 'image/png,image/jpeg,image/*'
        }
      }).toPromise();
      
      if (response) {
        // Check if the response is actually an image
        if (!response.type.startsWith('image/')) {
          console.warn('Response is not an image:', response.type);
          this.mapImageCache.set(mapUrl, 'error');
          return;
        }
        
        // Create blob URL
        const blobUrl = URL.createObjectURL(response);
        this.mapImageCache.set(mapUrl, blobUrl);
        console.log('Map image loaded successfully via proxy:', blobUrl);
        
        // Trigger change detection to re-render the component
        this.cdr.detectChanges();
      }
    } catch (error) {
      console.error('Failed to fetch map image via proxy:', error);
      // Check if it's a CORS error
      if (error instanceof Error && error.message.includes('CORS')) {
        console.warn('CORS error when fetching map image via proxy. Check proxy configuration.');
      }
      // Set a placeholder or error indicator in cache
      this.mapImageCache.set(mapUrl, 'error');
    }
  }
  onMapLoadError(event: any): void {
    console.error('Failed to load map image:', event);
    // You could set a placeholder image or error message here
    event.target.style.display = 'none';
  }  // Infinite scroll handlers
  onMessagesScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const threshold = 50; // Load more when within 50px of the top/bottom
    
    // Check if user is near the bottom (within 100px) to enable auto-scroll
    const distanceFromBottom = element.scrollHeight - (element.scrollTop + element.clientHeight);
    this.shouldAutoScroll = distanceFromBottom <= 100;
    
    // Check if scrolled to the top (load older messages)
    if (element.scrollTop <= threshold && this.chatService.messagesHasMore()) {
      this.loadMoreMessages();
    }
  }onSessionsScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const threshold = 50; // Load more when within 50px of the bottom
    
    // Check if scrolled to the bottom (load more sessions)
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - threshold && this.chatService.sessionsHasMore()) {
      this.loadMoreSessions();
    }
  }  private async loadMoreMessages(): Promise<void> {
    try {
      await this.chatService.loadMoreMessages();
    } catch (error) {
      console.error('Error loading more messages:', error);
    }
  }

  private async loadMoreSessions(): Promise<void> {    try {
      await this.chatService.loadMoreSessions();
    } catch (error) {
      console.error('Error loading more sessions:', error);
    }
  }  async viewDocument(doc: any): Promise<void> {
    try {
      const userId = this.authService.getUserId();
      const currentSession = this.chatService.currentSession();
      
      if (!userId) {
        console.error('User not authenticated');
        return;
      }
      
      if (!currentSession) {
        console.error('No current session');
        return;
      }

      // Download document through our backend API
      const response = await this.http.get(
        `${environment.api.baseUrl}/document/${doc.documentId}/download?userId=${encodeURIComponent(userId)}&sessionId=${encodeURIComponent(currentSession.id)}&filename=${encodeURIComponent(doc.fileName)}`,
        {
          responseType: 'blob'
        }
      ).toPromise();

      if (response) {
        // Create a blob URL and open it in a new tab
        const blobUrl = window.URL.createObjectURL(response);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.target = '_blank';
        link.click();
        
        // Clean up the blob URL after a short delay
        setTimeout(() => {
          window.URL.revokeObjectURL(blobUrl);
        }, 1000);
      }
    } catch (error) {
      console.error('Error viewing document:', error);
      // You could show a user-friendly error message here
    }
  }

  trackByDocumentId(index: number, doc: any): string {
    return doc.documentId;
  }
}
