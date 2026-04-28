import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { HttpResponse } from '@angular/common/http';
import { environment } from '@env/environment';

export interface DocumentMetadata {
  id: string;
  sessionId: string;
  title: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: string;
  chunksCount: number;
}

export interface DocumentUploadResponse {
  document: DocumentMetadata;
  message: string;
}

export interface DocumentSearchResult {
  id: string;
  title: string;
  contentSnippet: string;
  fileType: string;
  score: number;
}

export interface DocumentSearchResponse {
  results: DocumentSearchResult[];
  query: string;
}

@Injectable({ providedIn: 'root' })
export class DocumentService {
  private readonly apiUrl = environment.apiUrl + '/documents';

  constructor(private http: HttpClient) {}

  /**
   * Upload a document and index it for RAG.
   * The document is chunked, embedded, and stored in Azure AI Search.
   */
  uploadDocument(file: File, sessionId: string): Observable<DocumentUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('session_id', sessionId);
    
    return this.http.post<DocumentUploadResponse>(`${this.apiUrl}/upload`, formData);
  }

  /**
   * Search documents using semantic similarity.
   */
  searchDocuments(query: string, sessionId?: string, topK = 5): Observable<DocumentSearchResponse> {
    const params: Record<string, string> = { query, top_k: topK.toString() };
    if (sessionId) {
      params['session_id'] = sessionId;
    }
    return this.http.get<DocumentSearchResponse>(`${this.apiUrl}/search`, { params });
  }

  /**
   * Delete a specific document and all its chunks.
   */
  deleteDocument(documentId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.apiUrl}/${documentId}`);
  }

  /**
   * Delete all documents for a session.
   */
  deleteSessionDocuments(sessionId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.apiUrl}/session/${sessionId}`);
  }

  /**
   * Fetch document content as a Blob with auth headers applied by interceptor.
   */
  fetchDocumentContent(documentId: string): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.apiUrl}/${documentId}/content`, {
      responseType: 'blob',
      observe: 'response'
    });
  }
}
