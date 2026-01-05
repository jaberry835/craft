import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatMessage, AgentInteraction } from '../models/chat.models';

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  userId: string;
  sessionId: string;
  useRAG?: boolean;
  useMCPTools?: boolean;
}

export interface ChatCompletionResponse {
  message: ChatMessage;
  sources?: any[];
  toolCalls?: any[];
  agentInteractions?: AgentInteraction[];
}

@Injectable({
  providedIn: 'root'
})
export class OpenAIService {
  private http = inject(HttpClient);

  async generateChatCompletion(request: ChatCompletionRequest): Promise<Observable<ChatCompletionResponse>> {
    console.log('Generating chat completion via backend API...');
    
    // Use backend API instead of calling Azure OpenAI directly
    const backendUrl = `${environment.api.baseUrl}/chat/completions`;
    
    console.log('Backend API URL:', backendUrl);
    console.log('Chat completion request:', request);

    // Create headers without Azure OpenAI API key since backend handles it
    const headers = new HttpHeaders({
      'Content-Type': 'application/json'
    });

    return this.http.post<ChatCompletionResponse>(backendUrl, request, { headers }).pipe(
      map(response => {
        console.log('Backend API Response:', response);
        return response;
      })
    );
  }
}
