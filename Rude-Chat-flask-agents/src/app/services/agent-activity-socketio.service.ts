import { Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

export interface AgentActivity {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  status: 'starting' | 'in-progress' | 'completed' | 'error';
  timestamp: Date;
  details?: string;
  duration?: number;
}

export interface AgentStatus {
  agentId: string;
  name: string;
  status: 'idle' | 'active' | 'error';
  currentActivity?: string;
  lastActivity?: Date;
  domains: string[];
}

@Injectable({
  providedIn: 'root'
})
export class AgentActivityService {
  private activities = signal<AgentActivity[]>([]);
  private socket?: Socket;
  private currentSessionId?: string;
  private agentStatuses = signal<AgentStatus[]>([
    {
      agentId: 'core-agent',
      name: 'Core Agent',
      status: 'idle',
      domains: ['core', 'system', 'basic']
    },
    {
      agentId: 'adx-agent',
      name: 'ADX Agent',
      status: 'idle',
      domains: ['adx', 'data-explorer', 'kusto']
    },
    {
      agentId: 'maps-agent',
      name: 'Maps Agent',
      status: 'idle',
      domains: ['maps', 'location', 'geocoding']
    },
    {
      agentId: 'document-agent',
      name: 'Document Agent',
      status: 'idle',
      domains: ['documents', 'pdf', 'text-analysis']
    }
  ]);

  constructor() {
    this.initializeSocketConnection();
  }

  // Public getters for components
  getActivities = this.activities.asReadonly();
  getAgentStatuses = this.agentStatuses.asReadonly();

  private initializeSocketConnection() {
    try {
      console.log('🔌 Initializing SocketIO connection...');
      
      this.socket = io(environment.api.socketUrl, {
        transports: ['websocket', 'polling'], // WebSocket first, polling fallback
        autoConnect: false, // We'll connect manually
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000,
        forceNew: true
      });

      this.setupSocketEventHandlers();
      
      // Connect the socket
      this.socket.connect();
      
    } catch (error) {
      console.error('❌ Error initializing SocketIO connection:', error);
    }
  }

  private setupSocketEventHandlers() {
    if (!this.socket) return;

    // Connection events
    this.socket.on('connect', () => {
      console.log('✅ SocketIO connected successfully!');
      console.log('Socket ID:', this.socket?.id);
      
      // If we have a pending session, join it
      if (this.currentSessionId) {
        console.log('🔄 Reconnected - rejoining session:', this.currentSessionId);
        this.joinSession(this.currentSessionId);
      }
    });    this.socket.on('disconnect', (reason: string) => {
      console.log('❌ SocketIO disconnected:', reason);
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('❌ SocketIO connection error:', error);
    });

    this.socket.on('reconnect', (attemptNumber: number) => {
      console.log('🔄 SocketIO reconnected after', attemptNumber, 'attempts');
    });

    this.socket.on('reconnect_error', (error: Error) => {
      console.error('❌ SocketIO reconnection error:', error);
    });

    // Custom events
    this.socket.on('connection_status', (data: any) => {
      console.log('📡 Connection status:', data);
    });

    this.socket.on('session_joined', (data: any) => {
      console.log('✅ Successfully joined session:', data);
    });

    this.socket.on('session_left', (data: any) => {
      console.log('👋 Left session:', data);
    });

    this.socket.on('error', (error: any) => {
      console.error('❌ SocketIO error:', error);
    });

    // Agent activity events
    this.socket.on('agentActivity', (data: any) => {
      console.log('📊 Received agent activity:', data);
      this.handleRealtimeAgentActivity(data);
    });

    this.socket.on('pong', () => {
      console.log('🏓 Pong received');
    });
  }

  async joinSession(sessionId: string) {
    console.log('🚀 Joining session:', sessionId);
    
    // Validate sessionId
    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      console.error('❌ Invalid sessionId provided to joinSession:', sessionId);
      return;
    }

    // Clear activities when switching to a new session
    if (this.currentSessionId !== sessionId) {
      console.log('🔄 Switching from session', this.currentSessionId, 'to', sessionId, '- clearing activities');
      this.clearActivities();
    }

    this.currentSessionId = sessionId;

    if (!this.socket) {
      console.error('❌ Socket not initialized');
      return;
    }

    if (!this.socket.connected) {
      console.log('⏳ Socket not connected, waiting for connection...');
      
      // Wait for connection or timeout
      const waitForConnection = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000); // 5 second timeout
        
        if (this.socket?.connected) {
          clearTimeout(timeout);
          resolve(true);
          return;
        }
        
        this.socket?.once('connect', () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

      const connected = await waitForConnection;
      if (!connected) {
        console.error('❌ Socket connection timeout while joining session');
        return;
      }
    }

    try {
      console.log('📤 Emitting join_session event for session:', sessionId);
      this.socket.emit('join_session', {
        sessionId: sessionId,
        userId: 'current-user', // You might want to get this from auth service
        timestamp: new Date().toISOString()
      });

      console.log('✅ Join session request sent successfully');
      
    } catch (error) {
      console.error('❌ Error joining session:', error);
    }
  }

  async leaveSession() {
    if (!this.currentSessionId) {
      console.log('ℹ️ No active session to leave');
      return;
    }

    const sessionId = this.currentSessionId;
    console.log('👋 Leaving session:', sessionId);

    if (this.socket?.connected) {
      try {
        this.socket.emit('leave_session', {
          sessionId: sessionId
        });
        console.log('✅ Leave session request sent');
      } catch (error) {
        console.error('❌ Error leaving session:', error);
      }
    }

    this.currentSessionId = undefined;
    this.clearActivities();
  }

  private handleRealtimeAgentActivity(data: any) {
    console.log('📊 Processing real-time agent activity:', data);
    
    const activity: AgentActivity = {
      id: data.id || this.generateId(),
      agentId: data.agentName?.toLowerCase().replace(/\s+/g, '-') || 'unknown',
      agentName: data.agentName || 'Unknown Agent',
      action: data.action || 'Unknown Action',
      status: this.mapStatusFromBackend(data.status),
      timestamp: new Date(data.timestamp || Date.now()),
      details: data.result || data.details,
      duration: data.duration ? this.convertTimeSpanToMs(data.duration) : undefined
    };

    // Add to end of array for chronological order (newest at end)
    this.activities.update(activities => [...activities.slice(-99), activity]);
    this.updateAgentStatus(activity.agentId, activity.status, activity.action);
    
    console.log('✅ Agent activity processed and added to list');
  }

  private mapStatusFromBackend(status: string): AgentActivity['status'] {
    switch (status?.toLowerCase()) {
      case 'starting': return 'starting';
      case 'in-progress': return 'in-progress';
      case 'completed': 
      case 'success': return 'completed';
      case 'error': 
      case 'failed': return 'error';
      default: return 'in-progress';
    }
  }

  private convertTimeSpanToMs(timeSpan: any): number {
    if (typeof timeSpan === 'number') return timeSpan;
    if (typeof timeSpan === 'string') {
      // Parse TimeSpan format like "00:00:01.234"
      const parts = timeSpan.split(':');
      if (parts.length >= 3) {
        const seconds = parseFloat(parts[2]);
        const minutes = parseInt(parts[1]);
        const hours = parseInt(parts[0]);
        return (hours * 3600 + minutes * 60 + seconds) * 1000;
      }
    }
    return 0;
  }

  // Public methods for manual activity management
  addActivity(activity: Omit<AgentActivity, 'id' | 'timestamp'>): string {
    const id = this.generateId();
    const newActivity: AgentActivity = {
      ...activity,
      id,
      timestamp: new Date()
    };
    
    this.activities.update(activities => [...activities.slice(-99), newActivity]);
    this.updateAgentStatus(newActivity.agentId, newActivity.status, newActivity.action);
    
    return id;
  }

  addActivities(activitiesList: Omit<AgentActivity, 'id' | 'timestamp'>[]): string[] {
    const ids: string[] = [];
    const newActivities: AgentActivity[] = [];
    
    for (const activity of activitiesList) {
      const id = this.generateId();
      const newActivity: AgentActivity = {
        ...activity,
        id,
        timestamp: new Date()
      };
      ids.push(id);
      newActivities.push(newActivity);
      this.updateAgentStatus(newActivity.agentId, newActivity.status, newActivity.action);
    }
    
    this.activities.update(activities => [...activities.slice(-99 + newActivities.length), ...newActivities]);
    
    return ids;
  }

  updateActivity(id: string, updates: Partial<AgentActivity>) {
    this.activities.update(activities => 
      activities.map(activity => 
        activity.id === id 
          ? { ...activity, ...updates, timestamp: new Date() }
          : activity
      )
    );

    // Update agent status if status changed
    const updatedActivity = this.activities().find(a => a.id === id);
    if (updatedActivity && updates.status) {
      this.updateAgentStatus(updatedActivity.agentId, updates.status, updatedActivity.action);
    }
  }

  clearActivities() {
    console.log('🧹 Clearing agent activities');
    this.activities.set([]);
    
    // Reset all agent statuses to idle
    this.agentStatuses.update(statuses =>
      statuses.map(status => ({
        ...status,
        status: 'idle' as const,
        currentActivity: undefined,
        lastActivity: undefined
      }))
    );
  }

  private updateAgentStatus(agentId: string, status: AgentActivity['status'], activity: string) {
    this.agentStatuses.update(statuses =>
      statuses.map(agentStatus => 
        agentStatus.agentId === agentId
          ? {
              ...agentStatus,
              status: status === 'error' ? 'error' : (status === 'completed' ? 'idle' : 'active'),
              currentActivity: status === 'completed' ? undefined : activity,
              lastActivity: new Date()
            }
          : agentStatus
      )
    );
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // Health check methods
  ping() {
    if (this.socket?.connected) {
      console.log('🏓 Sending ping');
      this.socket.emit('ping');
    } else {
      console.log('❌ Cannot ping - socket not connected');
    }
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  // Cleanup
  disconnect() {
    if (this.socket) {
      console.log('🔌 Disconnecting SocketIO');
      this.socket.disconnect();
    }
  }
}
