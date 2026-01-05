import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class DocumentService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  /** Build a relative API path */
  private api(path: string) {
    return `/api/${path}`;
  }

  private requireAuth() {
    const user = this.auth.getUser();
    const userId = this.auth.getUserId();
    if (!user || !userId) throw new Error('User not authenticated');
    return userId;
  }

  uploadDocument(file: File, sessionId: string): Observable<any> {
    const userId = this.requireAuth();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', userId);
    formData.append('sessionId', sessionId);
    return this.http.post(this.api('document/upload'), formData);
  }

  getDocuments(sessionId: string): Observable<any[]> {
    const userId = this.requireAuth();
    const params = new HttpParams()
      .set('userId', userId)
      .set('sessionId', sessionId);
    return this.http.get<any[]>(this.api('document/'), { params });
  }

  deleteDocument(documentId: string): Observable<void> {
    const userId = this.requireAuth();
    const params = new HttpParams().set('userId', userId);
    return this.http.delete<void>(this.api(`document/${documentId}`), { params });
  }

  searchDocuments(req: DocumentSearchRequest): Observable<{ query: string; results: DocumentSearchResult[] }> {
    // assume the backend will fill in userId/sessionId if missing, or you can add them here
    return this.http.post<{ query: string; results: DocumentSearchResult[] }>(
      this.api('document/search'),
      req
    );
  }

  processDocument(documentId: string, blobUrl: string): Observable<any> {
    return this.http.post(this.api(`document/${documentId}/process`), { blobUrl });
  }
}
