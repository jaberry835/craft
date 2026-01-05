// This service now redirects to the SSE-based implementation
import { Injectable } from '@angular/core';
import { AgentActivityService as SSEAgentActivityService } from './agent-activity-sse.service';

// Re-export the SSE service as the main service
@Injectable({
  providedIn: 'root'
})
export class AgentActivityService extends SSEAgentActivityService {
  constructor() {
    super();
    console.log('🔄 AgentActivityService: Using SSE implementation');
  }
}

// Re-export interfaces for convenience
export type { AgentActivity, AgentStatus } from './agent-activity-sse.service';
