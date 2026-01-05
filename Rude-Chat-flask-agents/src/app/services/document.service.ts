import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, from } from 'rxjs';
import { environment } from '../../environments/environment';
import { UploadedDocument } from '../models/chat.models';
import { AuthService } from './auth.service';

export interface DocumentSearchRequest {
  query: string;
  userId: string;
  sessionId?: string;
  maxResults?: number;
}

export interface DocumentSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score?: number;
  chunkIndex: number;
}

@Injectable({
  providedIn: 'root'
})
export class DocumentService {
  private http = inject(HttpClient);
  private authService = inject(AuthService);
  private baseUrl = environment.api.baseUrl;
  async uploadDocument(file: File, sessionId: string): Promise<Observable<any>> {
    const user = this.authService.getUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    const userId = this.authService.getUserId();
    if (!userId) {
      throw new Error('User ID not available');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', userId);
    formData.append('sessionId', sessionId);

    return this.http.post(`${this.baseUrl}/document/upload`, formData);
  }
  async getDocuments(sessionId: string): Promise<Observable<any[]>> {
    const user = this.authService.getUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    const userId = this.authService.getUserId();
    if (!userId) {
      throw new Error('User ID not available');
    }

    const params = {
      userId: userId,
      sessionId: sessionId
    };

    return this.http.get<any[]>(`${this.baseUrl}/document`, { params });
  }
  async deleteDocument(documentId: string): Promise<Observable<void>> {
    const user = this.authService.getUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    const userId = this.authService.getUserId();
    if (!userId) {
      throw new Error('User ID not available');
    }

    const params = {
      userId: userId
    };

    return this.http.delete<void>(`${this.baseUrl}/document/${documentId}`, { params });
  }

  async searchDocuments(request: DocumentSearchRequest): Promise<Observable<{ query: string; results: DocumentSearchResult[] }>> {
    return this.http.post<{ query: string; results: DocumentSearchResult[] }>(
      `${this.baseUrl}/document/search`, 
      request
    );
  }

  async processDocument(documentId: string, blobUrl: string): Promise<Observable<any>> {
    return this.http.post(`${this.baseUrl}/document/${documentId}/process`, { blobUrl });
  }
}
