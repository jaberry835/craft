import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Session, Message, ChatService } from './chat.service';

/**
 * Shared state service for managing session state across components.
 * Allows sidebar and chat components to communicate without tight coupling.
 */
@Injectable({ providedIn: 'root' })
export class SessionStateService {
  private activeSessionId$ = new BehaviorSubject<string | undefined>(undefined);
  private sessionsRefresh$ = new Subject<void>();
  private pendingSession$ = new BehaviorSubject<Session | undefined>(undefined);
  
  constructor(private chatService: ChatService) {
    console.log('SessionStateService: constructor called, registering callback');
    // Register for new session completion events from the ChatService
    // This ensures sidebar refresh happens even if component is destroyed
    this.chatService.onNewSessionComplete((pendingId, realSessionId) => {
      console.log('SessionStateService: received new session complete from ChatService');
      this.handleNewSessionComplete(pendingId, realSessionId);
    });
    console.log('SessionStateService: callback registered');
  }
  
  /**
   * Handle when a new session stream completes - called from ChatService.
   */
  private handleNewSessionComplete(pendingId: string, realSessionId: string): void {
    // Only process if this pending session is still tracked
    if (!this.activeNewSessionStreams.has(pendingId)) {
      console.log('SessionStateService: pending session not tracked, ignoring', pendingId);
      return;
    }
    
    console.log('SessionStateService: handling new session complete', pendingId, '->', realSessionId);
    
    // Clean up tracking
    this.activeNewSessionStreams.delete(pendingId);
    
    // Map pending to real
    this.mapPendingToReal(pendingId, realSessionId);
    
    // Clear pending session
    this.clearPendingSession();
    
    // Refresh sidebar - THIS IS THE CRITICAL PART
    console.log('SessionStateService: refreshing sessions');
    this.refreshSessions();
  }
  
  /**
   * Get the current active session ID as an observable.
   */
  get activeSessionId(): Observable<string | undefined> {
    return this.activeSessionId$.asObservable();
  }
  
  /**
   * Get current active session ID value.
   */
  get currentSessionId(): string | undefined {
    return this.activeSessionId$.value;
  }
  
  /**
   * Set the active session ID.
   */
  setActiveSession(sessionId: string | undefined): void {
    this.activeSessionId$.next(sessionId);
  }
  
  /**
   * Observable that emits when sessions should be refreshed.
   */
  get sessionsRefresh(): Observable<void> {
    return this.sessionsRefresh$.asObservable();
  }
  
  /**
   * Trigger a refresh of the sessions list.
   */
  refreshSessions(): void {
    console.log('SessionStateService: triggering sessions refresh');
    this.sessionsRefresh$.next();
  }
  
  /**
   * Get pending (not yet saved) session for new chat.
   */
  get pendingSession(): Observable<Session | undefined> {
    return this.pendingSession$.asObservable();
  }
  
  /**
   * Set a pending session (optimistic update before backend confirms).
   */
  setPendingSession(session: Session | undefined): void {
    this.pendingSession$.next(session);
  }
  
  /**
   * Clear pending session after it's been saved.
   */
  clearPendingSession(): void {
    this.pendingSession$.next(undefined);
  }

  /**
   * Map of pending session IDs to real session IDs.
   * Used when a pending session is saved and we need to redirect.
   */
  private pendingToRealMap = new Map<string, string>();

  /**
   * Register a mapping from pending session ID to real session ID.
   */
  mapPendingToReal(pendingId: string, realId: string): void {
    this.pendingToRealMap.set(pendingId, realId);
  }

  /**
   * Get the real session ID for a pending session, if it exists.
   */
  getRealSessionId(pendingId: string): string | undefined {
    return this.pendingToRealMap.get(pendingId);
  }

  /**
   * Clear a pending-to-real mapping.
   */
  clearPendingMapping(pendingId: string): void {
    this.pendingToRealMap.delete(pendingId);
  }

  /**
   * Temporary message cache for transferring messages between component instances
   * when navigating from a new chat to its real session URL.
   */
  private cachedMessages = new Map<string, Message[]>();

  /**
   * Cache messages for a session (used when navigating to preserve streamed messages).
   */
  cacheMessages(sessionId: string, messages: Message[]): void {
    this.cachedMessages.set(sessionId, messages);
  }

  /**
   * Get and clear cached messages for a session.
   */
  popCachedMessages(sessionId: string): Message[] | undefined {
    const messages = this.cachedMessages.get(sessionId);
    if (messages) {
      this.cachedMessages.delete(sessionId);
    }
    return messages;
  }

  /**
   * Track pending session IDs that are currently being created (stream in progress).
   * This allows the service to know when to refresh even if components change.
   */
  private activeNewSessionStreams = new Set<string>();

  /**
   * Register that a new session stream is in progress.
   */
  registerActiveStream(pendingId: string): void {
    console.log('SessionStateService: registering active stream for', pendingId);
    this.activeNewSessionStreams.add(pendingId);
  }

  /**
   * Complete a new session stream - maps pending to real, clears pending, refreshes.
   * This method handles ALL the cleanup when a new session is created.
   */
  completeNewSession(pendingId: string, realSessionId: string, messages: Message[]): void {
    console.log('SessionStateService: completing new session', pendingId, '->', realSessionId);
    
    if (!this.activeNewSessionStreams.has(pendingId)) {
      console.log('SessionStateService: stream not registered, ignoring');
      return;
    }
    
    // Clean up tracking
    this.activeNewSessionStreams.delete(pendingId);
    
    // Map pending to real
    this.mapPendingToReal(pendingId, realSessionId);
    
    // Cache messages
    if (messages.length > 0) {
      this.cacheMessages(realSessionId, messages);
    }
    
    // Clear pending session
    this.clearPendingSession();
    
    // Refresh sidebar
    console.log('SessionStateService: refreshing sessions after stream complete');
    this.refreshSessions();
  }

  /**
   * Check if there's an active stream for a pending ID.
   */
  hasActiveStream(pendingId: string): boolean {
    return this.activeNewSessionStreams.has(pendingId);
  }
}
