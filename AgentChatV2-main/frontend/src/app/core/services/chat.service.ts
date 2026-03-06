import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { MsalService } from '@azure/msal-angular';
import { environment } from '@env/environment';

export interface SessionDocument {
  id: string;
  title: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: string;
  chunksCount: number;
}

export interface Session {
  id: string;
  title: string;
  orchestrationType: string;
  selectedAgents: string[];
  documents?: SessionDocument[];
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  orchestrationType?: string;
  agentIds?: string[];
  includeDocuments?: boolean;
  pendingSessionId?: string;  // For tracking new sessions
}

export interface SessionListResponse {
  sessions: Session[];
  continuationToken?: string;
  hasMore: boolean;
}

export interface MessageListResponse {
  messages: Message[];
  continuationToken?: string;
  hasMore: boolean;
}

// =============================================================================
// AG-UI Protocol Event Types (standardized SSE events from backend)
// =============================================================================

/** All AG-UI event type strings the backend can emit. */
export type AGUIEventType =
  | 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR'
  | 'STEP_STARTED' | 'STEP_FINISHED'
  | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START' | 'TOOL_CALL_ARGS' | 'TOOL_CALL_END' | 'TOOL_CALL_RESULT'
  | 'REASONING_START' | 'REASONING_MESSAGE_START' | 'REASONING_MESSAGE_CONTENT' | 'REASONING_MESSAGE_END' | 'REASONING_END'
  | 'CUSTOM';

/** A single AG-UI event received from the SSE stream. */
export interface AGUIEvent {
  type: AGUIEventType;
  timestamp?: string | null;

  // Lifecycle (RUN_STARTED / RUN_FINISHED)
  thread_id?: string;
  run_id?: string;

  // Steps (STEP_STARTED / STEP_FINISHED)
  step_name?: string;

  // Text messages (TEXT_MESSAGE_START / CONTENT / END)
  message_id?: string;
  role?: string;
  delta?: string;

  // Tool calls (TOOL_CALL_START / ARGS / END / RESULT)
  tool_call_id?: string;
  tool_call_name?: string;
  content?: string;        // TOOL_CALL_RESULT content

  // Custom events
  name?: string;           // CUSTOM event name
  value?: Record<string, unknown>;   // CUSTOM event payload

  // Error (RUN_ERROR)
  message?: string;        // Error message
}

// Callback for when a new session stream completes
export type NewSessionCompleteCallback = (pendingId: string, realSessionId: string) => void;

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly apiUrl = environment.apiUrl + '/chat';
  
  // Callback registry for new session completion
  private newSessionCompleteCallbacks: NewSessionCompleteCallback[] = [];
  
  constructor(
    private http: HttpClient,
    private msalService: MsalService
  ) {}
  
  /**
   * Register a callback to be notified when a new session stream completes.
   * This is used by the SessionStateService to refresh the sidebar.
   */
  onNewSessionComplete(callback: NewSessionCompleteCallback): void {
    console.log('ChatService: callback registered for new session completion');
    this.newSessionCompleteCallbacks.push(callback);
  }
  
  // Sessions
  getSessions(pageSize = 20, continuationToken?: string): Observable<SessionListResponse> {
    let params = new HttpParams().set('page_size', pageSize.toString());
    if (continuationToken) {
      params = params.set('continuation_token', continuationToken);
    }
    return this.http.get<SessionListResponse>(`${this.apiUrl}/sessions`, { params });
  }
  
  createSession(title: string, orchestrationType = 'sequential', selectedAgents: string[] = []): Observable<Session> {
    return this.http.post<Session>(`${this.apiUrl}/sessions`, {
      title,
      orchestration_type: orchestrationType,
      selected_agents: selectedAgents
    });
  }
  
  getSession(sessionId: string): Observable<Session> {
    return this.http.get<Session>(`${this.apiUrl}/sessions/${sessionId}`);
  }
  
  updateSession(sessionId: string, updates: Partial<Session>): Observable<Session> {
    return this.http.patch<Session>(`${this.apiUrl}/sessions/${sessionId}`, updates);
  }
  
  deleteSession(sessionId: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/sessions/${sessionId}`);
  }
  
  // Messages
  getMessages(sessionId: string, pageSize = 50, continuationToken?: string): Observable<MessageListResponse> {
    let params = new HttpParams()
      .set('page_size', pageSize.toString());
    if (continuationToken) {
      params = params.set('continuation_token', continuationToken);
    }
    return this.http.get<MessageListResponse>(
      `${this.apiUrl}/sessions/${sessionId}/messages`,
      { params }
    );
  }
  
  // Chat with streaming (AG-UI protocol)
  sendMessage(request: ChatRequest): Observable<AGUIEvent> {
    const subject = new Subject<AGUIEvent>();
    
    // Use fetch for SSE streaming
    this.streamChat(request, subject);
    
    return subject.asObservable();
  }
  
  private async streamChat(request: ChatRequest, subject: Subject<AGUIEvent>): Promise<void> {
    try {
      // Get token before making request
      const token = await this.getAuthToken();
      
      const response = await fetch(`${this.apiUrl}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify({
          message: request.message,
          session_id: request.sessionId,
          orchestration_type: request.orchestrationType,
          agent_ids: request.agentIds,
          include_documents: request.includeDocuments ?? true
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      console.log('ChatService: starting stream read, pendingSessionId:', request.pendingSessionId);
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('ChatService: stream read done');
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as AGUIEvent;
              
              // Log lifecycle events for debugging
              if (data.type === 'RUN_FINISHED' || data.type === 'RUN_ERROR') {
                console.log('ChatService: received', data.type, {
                  pendingSessionId: request.pendingSessionId,
                  threadId: data.thread_id,
                });
              }
              
              subject.next(data);
              
              // If this is a CUSTOM session_created event, notify callbacks
              if (data.type === 'CUSTOM' &&
                  data.name === 'session_created' &&
                  request.pendingSessionId &&
                  data.value?.['session_id']) {
                const realSessionId = data.value['session_id'] as string;
                console.log('ChatService: new session created, notifying callbacks',
                  request.pendingSessionId, '->', realSessionId);
                this.newSessionCompleteCallbacks.forEach(cb =>
                  cb(request.pendingSessionId!, realSessionId)
                );
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', e);
            }
          }
        }
      }
      
      console.log('ChatService: stream complete');
      subject.complete();
    } catch (error) {
      subject.error(error);
    }
  }
  
  private async getAuthToken(): Promise<string> {
    // Try to get active account first, then fall back to first available account
    let account = this.msalService.instance.getActiveAccount();
    console.log('ChatService.getAuthToken: active account:', account?.username);
    
    if (!account) {
      // No active account set - get all accounts and use the first one
      const accounts = this.msalService.instance.getAllAccounts();
      console.log('ChatService.getAuthToken: no active account, all accounts:', accounts.length);
      
      if (accounts.length > 0) {
        account = accounts[0];
        // Set this as the active account for future use
        this.msalService.instance.setActiveAccount(account);
        console.log('ChatService.getAuthToken: set active account to:', account.username);
      } else {
        console.warn('ChatService.getAuthToken: No MSAL accounts available');
        return '';
      }
    }
    
    try {
      console.log('ChatService.getAuthToken: acquiring token with scopes:', environment.apiScopes);
      const result = await this.msalService.instance.acquireTokenSilent({
        scopes: environment.apiScopes,
        account: account
      });
      console.log('ChatService.getAuthToken: token acquired, length:', result.accessToken?.length);
      return result.accessToken;
    } catch (error) {
      console.error('ChatService.getAuthToken: Failed to acquire token:', error);
      return '';
    }
  }
}
