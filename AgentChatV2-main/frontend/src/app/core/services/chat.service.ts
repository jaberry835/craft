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

export interface StreamChunk {
  type: 'content' | 'agent_start' | 'agent_end' | 'error' | 'done' | 'chatter';
  agentId?: string;
  agentName?: string;
  content?: string;
  session_id?: string;  // Sent by backend on 'done' event for new sessions
  metadata?: Record<string, unknown>;
  // Chatter event fields (when type === 'chatter')
  chatter_type?: 'thinking' | 'tool_call' | 'tool_result' | 'delegation' | 'content';
  agent_name?: string;  // Backend uses snake_case
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  duration_ms?: number;    // Duration of tool execution in ms
  tokens_input?: number;   // Input tokens for LLM calls
  tokens_output?: number;  // Output tokens for LLM calls
  friendly_message?: string;  // User-friendly description of the action
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
      .set('page_size', pageSize.toString())
      .set('oldest_first', 'true');
    if (continuationToken) {
      params = params.set('continuation_token', continuationToken);
    }
    return this.http.get<MessageListResponse>(
      `${this.apiUrl}/sessions/${sessionId}/messages`,
      { params }
    );
  }
  
  // Chat with streaming
  sendMessage(request: ChatRequest): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    
    // Use fetch for SSE streaming
    this.streamChat(request, subject);
    
    return subject.asObservable();
  }
  
  private async streamChat(request: ChatRequest, subject: Subject<StreamChunk>): Promise<void> {
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
              const data = JSON.parse(line.slice(6)) as StreamChunk;
              
              // Log all done chunks for debugging
              if (data.type === 'done') {
                console.log('ChatService: received done chunk', {
                  pendingSessionId: request.pendingSessionId,
                  sessionId: data.session_id,
                  hasSessionId: !!data.session_id
                });
              }
              
              subject.next(data);
              
              // If this is a new session completing, notify callbacks from the SERVICE
              // This ensures the callback runs even if the component is destroyed
              if (data.type === 'done' && 
                  request.pendingSessionId && 
                  data.session_id) {
                console.log('ChatService: new session created, notifying callbacks', 
                  request.pendingSessionId, '->', data.session_id);
                this.newSessionCompleteCallbacks.forEach(cb => 
                  cb(request.pendingSessionId!, data.session_id!)
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
