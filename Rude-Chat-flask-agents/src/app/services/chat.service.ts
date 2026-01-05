import { Injectable, inject, signal } from '@angular/core';
import { Observable, BehaviorSubject, firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ChatSession, ChatMessage, ChatHistoryResponse, SessionListResponse } from '../models/chat.models';
import { AuthService } from './auth.service';
import { OpenAIService, ChatCompletionRequest, ChatCompletionResponse } from './openai.service';
import { MCPService } from './mcp.service';
import { DocumentService, DocumentSearchRequest } from './document.service';
import { AgentActivityService } from './agent-activity-socketio.service';
import { environment } from '../../environments/environment';
import { v4 as uuidv4 } from 'uuid';

@Injectable({
  providedIn: 'root'
})
export class ChatService {  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private baseUrl = `${environment.api.baseUrl}/chat`;
  private openaiService = inject(OpenAIService);
  private mcpService = inject(MCPService);
  private documentService = inject(DocumentService);
  private agentActivityService = inject(AgentActivityService);// Signals for reactive state management
  currentSession = signal<ChatSession | null>(null);
  sessions = signal<ChatSession[]>([]);
  isTyping = signal<boolean>(false);
  mcpEnabled = signal<boolean>(false);
  availableTools = signal<any[]>([]);
  ragActive = signal<boolean>(false);
    // Pagination state
  private sessionsContinuationToken = signal<string | null>(null);
  private _sessionsHasMore = signal<boolean>(true);
  private _isLoadingSessions = signal<boolean>(false);
  
  private messagesContinuationToken = signal<string | null>(null);
  private _messagesHasMore = signal<boolean>(true);
  private _isLoadingMessages = signal<boolean>(false);

  private messagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  messages$ = this.messagesSubject.asObservable();
  constructor() {
    // Log environment and URL configuration for debugging
    console.log('ChatService - Environment API base URL:', environment.api.baseUrl);
    console.log('ChatService - Constructed base URL:', this.baseUrl);
      // Initialize MCP service
    this.initializeMCP(); // Re-enabled for MCP agent testing
    console.log('MCP initialization enabled for agent testing');
  }
  private async initializeMCP(): Promise<void> {
    try {
      console.log('Checking MCP server availability...');
      const isAvailable = await this.mcpService.isServerAvailable();
      console.log('MCP server available:', isAvailable);
      
      if (isAvailable) {
        console.log('Initializing MCP...');
        await this.mcpService.initializeMCP();
        this.mcpEnabled.set(true);
        
        // Subscribe to available tools
        this.mcpService.availableTools$.subscribe(tools => {
          this.availableTools.set(tools);
          console.log('MCP tools updated:', tools);
        });
        
        console.log('MCP initialization complete. Enabled:', this.mcpEnabled());
      } else {
        console.log('MCP server not available');
        this.mcpEnabled.set(false);
      }
    } catch (error) {
      console.error('Error initializing MCP:', error);
      this.mcpEnabled.set(false);
    }
  }
  async createNewSession(): Promise<ChatSession> {
    const userId = this.authService.getUserId();
    if (!userId) throw new Error('User not authenticated');

    try {      // Create session on the backend
      const response = await firstValueFrom(
        this.http.post<{ sessionId: string }>(`${this.baseUrl}/session`, {
          userId,
          title: `New Chat ${new Date().toLocaleTimeString()}`
        })
      );

      const newSession: ChatSession = {
        id: response.sessionId,
        title: `New Chat ${new Date().toLocaleTimeString()}`,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        userId
      };      this.currentSession.set(newSession);
      this.messagesSubject.next([]);
      
      // Join agent activity session for real-time updates
      await this.agentActivityService.joinSession(newSession.id);
      
      // Refresh sessions list
      await this.loadSessions();

      return newSession;
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }  async loadSession(sessionId: string, reset: boolean = true): Promise<void> {
    const userId = this.authService.getUserId();
    if (!userId) throw new Error('User not authenticated');    if (this._isLoadingMessages()) return;
    this._isLoadingMessages.set(true);

    try {      const params: any = {
        userId,
        sessionId,
        pageSize: '20'  // Standard page size for message loading
      };

      if (!reset && this.messagesContinuationToken()) {
        params.continuationToken = this.messagesContinuationToken();
      }

      // Load session messages from the backend
      const response = await firstValueFrom(
        this.http.get<ChatHistoryResponse>(
          `${this.baseUrl}/history`,
          { params }
        )
      );

      // Find the session in the current sessions list
      const session = this.sessions().find(s => s.id === sessionId);
      if (session) {
        let messages = response.messages;
        
        if (!reset && this.currentSession()?.messages) {
          // Prepend older messages for infinite scroll
          messages = [...response.messages, ...this.currentSession()!.messages];
        }

        const updatedSession = {
          ...session,
          messages: messages
        };
          this.currentSession.set(updatedSession);
        this.messagesSubject.next(messages);
          // Join agent activity session for real-time updates (only on reset/initial load)
        if (reset) {
          // Leave previous session first
          await this.agentActivityService.leaveSession();
          await this.agentActivityService.joinSession(sessionId);
        }
          // Update pagination state
        this.messagesContinuationToken.set(response.continuationToken || null);
        this._messagesHasMore.set(response.hasMore || false);
      }
    } catch (error) {
      console.error('Error loading session:', error);
      throw error;
    } finally {
      this._isLoadingMessages.set(false);
    }
  }  // Load more messages (older messages) for infinite scroll
  async loadMoreMessages(): Promise<void> {
    const currentSession = this.currentSession();
    if (!currentSession || !this._messagesHasMore() || this._isLoadingMessages()) {
      return;
    }
    
    await this.loadSession(currentSession.id, false);
  }

  async addMessage(message: ChatMessage, updateUI: boolean = true): Promise<void> {
    const currentSession = this.currentSession();
    if (!currentSession) return;

    try {
      // Save message to backend
      await firstValueFrom(
        this.http.post<{ messageId: string }>(`${this.baseUrl}/message`, {
          ...message,
          sessionId: currentSession.id,
          userId: this.authService.getUserId()
        })
      );

      // Update local state only if requested
      if (updateUI) {
        const updatedMessages = [...currentSession.messages, message];
        const isFirstMessage = updatedMessages.length === 1;
        const newTitle = isFirstMessage ? this.generateSessionTitle(message.content) : currentSession.title;
        
        const updatedSession = {
          ...currentSession,
          messages: updatedMessages,
          updatedAt: new Date(),
          title: newTitle
        };

        this.currentSession.set(updatedSession);
        this.messagesSubject.next(updatedMessages);
        this.updateSessionInList(updatedSession);
        
        // Update session title in backend if it's the first message
        if (isFirstMessage && message.role === 'user') {
          try {
            await firstValueFrom(
              this.http.put(`${this.baseUrl}/session/${currentSession.id}`, updatedSession)
            );
          } catch (error) {
            console.error('Error updating session title in backend:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Error saving message:', error);
      // Continue with local update even if save fails (only if updateUI is true)
      if (updateUI) {
        const updatedMessages = [...currentSession.messages, message];
        const isFirstMessage = updatedMessages.length === 1;
        const newTitle = isFirstMessage ? this.generateSessionTitle(message.content) : currentSession.title;
        
        const updatedSession = {
          ...currentSession,
          messages: updatedMessages,
          updatedAt: new Date(),
          title: newTitle
        };

        this.currentSession.set(updatedSession);
        this.messagesSubject.next(updatedMessages);
        this.updateSessionInList(updatedSession);
      }
    }
  }

  updateMessage(messageId: string, updates: Partial<ChatMessage>): void {
    const currentSession = this.currentSession();
    if (!currentSession) return;

    const updatedMessages = currentSession.messages.map(msg =>
      msg.id === messageId ? { ...msg, ...updates } : msg
    );

    const updatedSession = {
      ...currentSession,
      messages: updatedMessages,
      updatedAt: new Date()
    };

    this.currentSession.set(updatedSession);
    this.messagesSubject.next(updatedMessages);
    this.updateSessionInList(updatedSession);
  }

  private updateSessionInList(updatedSession: ChatSession): void {
    const sessions = this.sessions();
    const updatedSessions = sessions.map(session =>
      session.id === updatedSession.id ? updatedSession : session
    );
    this.sessions.set(updatedSessions);
  }

  private generateSessionTitle(firstMessage: string): string {
    return firstMessage.length > 30 
      ? firstMessage.substring(0, 30) + '...'
      : firstMessage;
  }  async sendMessage(content: string): Promise<void> {
    const currentSession = this.currentSession();
    if (!currentSession) {
      console.error('No active session');
      return;
    }

    const userId = this.authService.getUserId();
    if (!userId) {
      console.error('User not authenticated');
      return;
    }

    // Create user message
    const userMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: new Date()
    };
    
    // IMMEDIATELY update UI state first (for instant feedback)
    const isFirstMessage = currentSession.messages.length === 0;
    const newTitle = isFirstMessage ? this.generateSessionTitle(content) : currentSession.title;
    
    const immediateUpdatedMessages = [...currentSession.messages, userMessage];
    const immediateUpdatedSession = {
      ...currentSession,
      messages: immediateUpdatedMessages,
      updatedAt: new Date(),
      title: newTitle
    };

    // Update UI immediately
    this.currentSession.set(immediateUpdatedSession);
    this.messagesSubject.next(immediateUpdatedMessages);
    this.updateSessionInList(immediateUpdatedSession);
    
    // Set typing indicator
    this.isTyping.set(true);    try {      // Save user message to backend (async, non-blocking for UI)
      await this.addMessage(userMessage, false);
        // Update session title in backend if it's the first message
      if (isFirstMessage) {
        try {
          console.log('Updating session title in backend for first message:', currentSession.id, '->', newTitle);
          await firstValueFrom(
            this.http.put(`${this.baseUrl}/session/${currentSession.id}`, immediateUpdatedSession)
          );
        } catch (titleError) {
          console.error('Error updating session title in backend:', titleError);
        }
      }
      
      // Check for uploaded documents and perform RAG search if available
      let ragContext = '';
      let useRAG = false;
      
      try {
        // Search for relevant documents
        const searchRequest: DocumentSearchRequest = {
          query: content,
          userId: userId,
          sessionId: currentSession.id,
          maxResults: 5
        };
          const searchObservable = await this.documentService.searchDocuments(searchRequest);
        const searchResult = await firstValueFrom(searchObservable);
        
        console.log('Document search request:', searchRequest);
        console.log('Document search result:', searchResult);
        
        if (searchResult.results && searchResult.results.length > 0) {
          useRAG = true;
          this.ragActive.set(true);
          ragContext = searchResult.results
            .map(result => `Document: ${result.documentId}\nContent: ${result.content}`)
            .join('\n\n');
          
          console.log('RAG context found:', ragContext);
        } else {
          console.log('No results found in search response');
        }
      } catch (searchError) {
        console.log('No documents found or search failed:', searchError);
        // Continue without RAG if document search fails
      }

      // Prepare messages with RAG context if available
      let messages = [...currentSession.messages, userMessage];
      
      if (useRAG && ragContext) {
        // Insert RAG context as a system message before the user's message
        const ragSystemMessage: ChatMessage = {
          id: uuidv4(),
          role: 'system',
          content: `Based on the following uploaded documents, please answer the user's question. If the documents don't contain relevant information, you can still provide a general response.\n\nRelevant document content:\n${ragContext}`,
          timestamp: new Date()
        };
        
        // Insert RAG context before the user message
        messages = [...currentSession.messages, ragSystemMessage, userMessage];
      }

      // Prepare request for OpenAI
      const request: ChatCompletionRequest = {
        messages: messages,
        userId,
        sessionId: currentSession.id,
        useRAG: useRAG,
        useMCPTools: this.mcpEnabled()
      };      // Get response from OpenAI
      const responseObservable = await this.openaiService.generateChatCompletion(request);
      const response: ChatCompletionResponse = await firstValueFrom(responseObservable);

      // Process agent interactions if present
      if (response.agentInteractions && response.agentInteractions.length > 0) {
        console.log('Processing agent interactions:', response.agentInteractions);
        
        // Convert backend AgentInteraction to frontend AgentActivity
        const activities = response.agentInteractions.map(interaction => ({
          id: interaction.id,
          agentId: this.mapAgentNameToId(interaction.agentName),
          agentName: interaction.agentName,
          action: interaction.action,
          status: this.mapStatusToActivity(interaction.status),
          timestamp: new Date(interaction.timestamp),
          details: interaction.result,
          duration: interaction.duration ? interaction.duration / 1000 : undefined // Convert from ms to seconds
        }));
        
        // Add activities to the agent activity service
        this.agentActivityService.addActivities(activities);
      }

      // The backend already saved the assistant message, so we just need to update our local state
      const finalUpdatedMessages = [...immediateUpdatedMessages, response.message];
      const finalUpdatedSession = {
        ...immediateUpdatedSession,
        messages: finalUpdatedMessages,
        updatedAt: new Date()
      };

      this.currentSession.set(finalUpdatedSession);
      this.messagesSubject.next(finalUpdatedMessages);
      this.updateSessionInList(finalUpdatedSession);
      
    } catch (error) {
      console.error('Error sending message to OpenAI:', error);
        // Add error message
      const errorMessage: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: 'Sorry, I encountered an error processing your request. Please try again.',
        timestamp: new Date()
      };
      
      // Update state with error message
      const errorUpdatedMessages = [...immediateUpdatedMessages, errorMessage];
      const errorUpdatedSession = {
        ...immediateUpdatedSession,
        messages: errorUpdatedMessages,
        updatedAt: new Date()
      };

      this.currentSession.set(errorUpdatedSession);
      this.messagesSubject.next(errorUpdatedMessages);
      this.updateSessionInList(errorUpdatedSession);
      
      await this.addMessage(errorMessage, false);
    } finally {
      this.isTyping.set(false);
      this.ragActive.set(false);
    }
  }// Load sessions from backend
  async loadSessions(reset: boolean = true): Promise<void> {
    const userId = this.authService.getUserId();
    if (!userId) return;
    if (this._isLoadingSessions()) return;
    this._isLoadingSessions.set(true);

    try {
      const params: any = {
        userId,
        pageSize: '20'  // Standard page size for session loading
      };

      if (!reset && this.sessionsContinuationToken()) {
        params.continuationToken = this.sessionsContinuationToken();
      }

      const url = `${this.baseUrl}/sessions`;
      console.log('ChatService.loadSessions - GET', url, params);
      const response = await firstValueFrom(
        this.http.get<SessionListResponse>(
          url,
          { params }
        )
      );
      if (reset) {
        this.sessions.set(response.sessions || []);
        // Auto-select the most recent session if none is currently selected
        if (!this.currentSession() && response.sessions && response.sessions.length > 0) {
          console.log('Auto-selecting most recent session:', response.sessions[0].id);
          await this.loadSession(response.sessions[0].id);
        }
      } else {
        // Append new sessions for infinite scroll
        const currentSessions = this.sessions();
        this.sessions.set([...currentSessions, ...(response.sessions || [])]);
      }
      this.sessionsContinuationToken.set(response.continuationToken || null);
      this._sessionsHasMore.set(response.hasMore || false);
    } catch (error) {
      console.error('Error loading sessions from backend:', error);
      if (reset) {
        this.sessions.set([]);
      }
    } finally {
      this._isLoadingSessions.set(false);
    }
  }  // Load more sessions for infinite scroll
  async loadMoreSessions(): Promise<void> {
    if (!this._sessionsHasMore() || this._isLoadingSessions()) {
      return;
    }
    
    await this.loadSessions(false);
  }
  async deleteSession(sessionId: string): Promise<void> {
    const userId = this.authService.getUserId();
    if (!userId) return;

    try {
      await firstValueFrom(
        this.http.delete(`${this.baseUrl}/session/${sessionId}`, {
          params: { userId }
        })
      );

      // Update local state
      const sessions = this.sessions().filter(s => s.id !== sessionId);
      this.sessions.set(sessions);
        if (this.currentSession()?.id === sessionId) {
        await this.agentActivityService.leaveSession();
        this.currentSession.set(null);
        this.messagesSubject.next([]);
      }
    } catch (error) {      console.error('Error deleting session:', error);
      throw error;
    }
  }
  // Pagination getters
  get isLoadingSessions() {
    return this._isLoadingSessions;
  }

  get isLoadingMessages() {
    return this._isLoadingMessages;
  }

  get sessionsHasMore() {
    return this._sessionsHasMore;
  }

  get messagesHasMore() {
    return this._messagesHasMore;
  }

  private mapAgentNameToId(agentName: string): string {
    const agentMap: { [key: string]: string } = {
      'Orchestrator': 'core-agent',
      'ADX Agent': 'adx-agent',
      'Maps Agent': 'maps-agent',
      'Documents Agent': 'documents-agent',
      'Azure Agent': 'resources-agent'
    };
    return agentMap[agentName] || 'core-agent';
  }

  private mapStatusToActivity(status: string): 'starting' | 'in-progress' | 'completed' | 'error' {
    const statusMap: { [key: string]: 'starting' | 'in-progress' | 'completed' | 'error' } = {
      'in-progress': 'in-progress',
      'success': 'completed',
      'error': 'error'
    };
    return statusMap[status] || 'completed';
  }
}
