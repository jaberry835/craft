// This service now redirects to the SocketIO-based implementation
import { Injectable } from '@angular/core';
import { AgentActivityService as SocketIOAgentActivityService } from './agent-activity-socketio.service';

// Re-export the SocketIO service as the main service
@Injectable({
  providedIn: 'root'
})
export class AgentActivityService extends SocketIOAgentActivityService {
  constructor() {
    super();
    console.log('🔄 AgentActivityService: Using SocketIO implementation');
  }
}

// Re-export interfaces for convenience
export type { AgentActivity, AgentStatus } from './agent-activity-socketio.service';
