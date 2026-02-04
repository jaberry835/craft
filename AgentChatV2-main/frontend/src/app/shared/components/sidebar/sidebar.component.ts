import { Component, OnInit, OnDestroy } from '@angular/core';
import { RouterLink, Router, NavigationEnd } from '@angular/router';
import { Subject, takeUntil, filter } from 'rxjs';
import { AsyncPipe } from '@angular/common';

import { ChatService, Session, SessionListResponse } from '../../../core/services/chat.service';
import { SessionStateService } from '../../../core/services/session-state.service';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, AsyncPipe],
  template: `
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">Agent Chat</h1>
        <button class="btn btn-primary new-chat-btn" (click)="createNewSession()">
          <span class="material-icons">add</span>
          New Chat
        </button>
      </div>
      
      <div class="sessions-list">
        <div class="sessions-header">
          <span>Recent Chats</span>
        </div>
        
        <div class="session-items">
          @if (pendingSession && (!activeSessionId || activeSessionId === pendingSession.id)) {
            <div 
              class="session-item active pending"
              [routerLink]="['/chat', pendingSession.id]"
            >
              <span class="material-icons">pending</span>
              <span class="session-title">{{ pendingSession.title }}</span>
            </div>
          }
          
          @for (session of sessions; track session.id) {
            <div 
              class="session-item" 
              [class.active]="session.id === activeSessionId"
              [routerLink]="['/chat', session.id]"
            >
              <span class="material-icons">chat_bubble_outline</span>
              <span class="session-title">{{ session.title }}</span>
              <button 
                class="btn btn-icon delete-btn" 
                (click)="deleteSession(session.id, $event)"
              >
                <span class="material-icons">delete_outline</span>
              </button>
            </div>
          }
          
          @if (hasMore) {
            <button class="btn btn-secondary load-more" (click)="loadMore()">
              Load More
            </button>
          }
        </div>
      </div>
      
      @if (authService.isAdmin$ | async) {
        <div class="sidebar-footer">
          <a routerLink="/admin" class="admin-link">
            <span class="material-icons">settings</span>
            Admin
          </a>
        </div>
      }
    </aside>
  `,
  styles: [`
    .sidebar {
      width: 280px;
      height: 100vh;
      background-color: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
    }
    
    .sidebar-header {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }
    
    .logo {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: var(--spacing-md);
      color: var(--primary);
    }
    
    .new-chat-btn {
      width: 100%;
    }
    
    .sessions-list {
      flex: 1;
      overflow-y: auto;
    }
    
    .sessions-header {
      padding: var(--spacing-md);
      font-size: 12px;
      text-transform: uppercase;
      color: var(--text-muted);
      font-weight: 600;
    }
    
    .session-items {
      padding: 0 var(--spacing-sm);
    }
    
    .session-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: 6px;
      cursor: pointer;
      transition: background-color var(--transition-fast);
      text-decoration: none;
      color: var(--text-primary);
      
      &:hover {
        background-color: var(--bg-hover);
        
        .delete-btn {
          opacity: 1;
        }
      }
      
      &.active {
        background-color: var(--bg-tertiary);
      }
      
      &.pending {
        font-style: italic;
        opacity: 0.8;
        
        .material-icons {
          animation: pulse 1.5s infinite;
        }
      }
      
      .material-icons {
        font-size: 18px;
        color: var(--text-muted);
      }
      
      .session-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 14px;
      }
      
      .delete-btn {
        opacity: 0;
        transition: opacity var(--transition-fast);
        padding: 4px;
        
        .material-icons {
          font-size: 16px;
        }
      }
    }
    
    .load-more {
      width: 100%;
      margin-top: var(--spacing-sm);
    }
    
    .sidebar-footer {
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }
    
    .admin-link {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      color: var(--text-secondary);
      text-decoration: none;
      padding: var(--spacing-sm);
      border-radius: 6px;
      
      &:hover {
        background-color: var(--bg-hover);
        color: var(--text-primary);
      }
    }
  `]
})
export class SidebarComponent implements OnInit, OnDestroy {
  sessions: Session[] = [];
  activeSessionId?: string;
  pendingSession?: Session;
  hasMore = false;
  private continuationToken?: string;
  private destroy$ = new Subject<void>();
  
  constructor(
    private chatService: ChatService,
    private sessionState: SessionStateService,
    private router: Router,
    public authService: AuthService  // Public so template can access isAdmin$
  ) {}
  
  ngOnInit(): void {
    // Check admin role on init (refreshes after login)
    this.authService.checkAdminRole();
    
    this.loadSessions();
    
    // Track active session from route
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntil(this.destroy$)
    ).subscribe((event) => {
      const match = event.urlAfterRedirects.match(/\/chat\/([^/]+)/);
      this.activeSessionId = match ? match[1] : undefined;
      this.sessionState.setActiveSession(this.activeSessionId);
    });
    
    // Subscribe to session refresh requests
    this.sessionState.sessionsRefresh.pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      console.log('Sidebar: received refresh signal, loading sessions');
      this.loadSessions();
    });
    
    // Track pending session for optimistic UI
    this.sessionState.pendingSession.pipe(
      takeUntil(this.destroy$)
    ).subscribe(session => {
      this.pendingSession = session;
    });
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  loadSessions(): void {
    this.chatService.getSessions()
      .pipe(takeUntil(this.destroy$))
      .subscribe((response: SessionListResponse) => {
        this.sessions = response.sessions;
        this.continuationToken = response.continuationToken;
        this.hasMore = response.hasMore;
      });
  }
  
  loadMore(): void {
    if (!this.continuationToken) return;
    
    this.chatService.getSessions(20, this.continuationToken)
      .pipe(takeUntil(this.destroy$))
      .subscribe((response: SessionListResponse) => {
        this.sessions = [...this.sessions, ...response.sessions];
        this.continuationToken = response.continuationToken;
        this.hasMore = response.hasMore;
      });
  }
  
  createNewSession(): void {
    this.router.navigate(['/']);
  }
  
  deleteSession(sessionId: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    
    if (confirm('Delete this chat session?')) {
      this.chatService.deleteSession(sessionId)
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          this.sessions = this.sessions.filter(s => s.id !== sessionId);
          if (this.activeSessionId === sessionId) {
            this.router.navigate(['/']);
          }
        });
    }
  }
}
