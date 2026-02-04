import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';

import { AgentService, AgentConfig, MCPToolConfig, A2ADiscoveryResponse } from '../../core/services/agent.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="admin-container">
      <div class="admin-header">
        <h1>Agent Administration</h1>
        <div class="header-actions">
          <button class="btn btn-secondary" (click)="openA2AModal()">
            <span class="material-icons">link</span>
            Add A2A Agent
          </button>
          <button class="btn btn-primary" (click)="openEditor()">
            <span class="material-icons">add</span>
            New Agent
          </button>
        </div>
      </div>
      
      <div class="agents-list">
        @for (agent of agents; track agent.id) {
          <div class="agent-card" [class.a2a-agent]="agent.agent_type === 'a2a'">
            <div class="agent-header">
              <div class="agent-icon" [class.orchestrator]="agent.is_orchestrator" [class.a2a]="agent.agent_type === 'a2a'">
                <span class="material-icons">
                  {{ agent.agent_type === 'a2a' ? 'cloud' : (agent.is_orchestrator ? 'hub' : 'smart_toy') }}
                </span>
              </div>
              <div class="agent-title">
                <h3>{{ agent.name }}</h3>
                @if (agent.is_orchestrator) {
                  <span class="agent-badge">Orchestrator</span>
                }
                @if (agent.agent_type === 'a2a') {
                  <span class="agent-badge a2a">A2A External</span>
                }
              </div>
              <div class="agent-actions">
                <button class="btn btn-icon" (click)="editAgent(agent)" title="Edit" [disabled]="agent.agent_type === 'a2a'">
                  <span class="material-icons">edit</span>
                </button>
                <button class="btn btn-icon" (click)="deleteAgent(agent.id!)" title="Delete">
                  <span class="material-icons">delete</span>
                </button>
              </div>
            </div>
            
            <p class="agent-description">{{ agent.description || 'No description' }}</p>
            
            <div class="agent-meta">
              @if (agent.agent_type === 'a2a') {
                <span class="meta-item">
                  <span class="material-icons">link</span>
                  {{ agent.a2a_url }}
                </span>
              } @else {
                <span class="meta-item">
                  <span class="material-icons">memory</span>
                  {{ agent.model || 'No Model Configured' }}
                </span>
                <span class="meta-item">
                  <span class="material-icons">extension</span>
                  {{ agent.mcp_tools?.length || 0 }} Tools
                </span>
                @if (!agent.is_orchestrator) {
                  <span class="meta-item a2a-url" title="Agent-to-Agent (A2A) Protocol URL - Use this endpoint to connect external agents">
                    <span class="material-icons">link</span>
                    <span class="url-text">{{ getAgentA2AUrl(agent) }}</span>
                    <button class="btn-copy" (click)="copyA2AUrl(agent, $event)" title="Copy A2A URL">
                      <span class="material-icons">{{ copiedAgentId === agent.id ? 'check' : 'content_copy' }}</span>
                    </button>
                  </span>
                }
              }
            </div>
          </div>
        }
        
        @if (agents.length === 0 && !isLoading) {
          <div class="empty-state">
            <span class="material-icons">smart_toy</span>
            <h3>No agents configured</h3>
            <p>Create your first agent or seed default agents to get started.</p>
          </div>
        }
      </div>
      
      <!-- Agent Editor Modal -->
      @if (showEditor) {
        <div class="modal-overlay" (click)="closeEditor()">
          <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h2>{{ editingAgent?.id ? 'Edit' : 'Create' }} Agent</h2>
            <button class="btn btn-icon" (click)="closeEditor()">
              <span class="material-icons">close</span>
            </button>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label>Name *</label>
              <input 
                type="text" 
                class="input" 
                [(ngModel)]="editingAgent!.name"
                placeholder="Agent name"
              />
            </div>
            
            <div class="form-group">
              <label>Description</label>
              <input 
                type="text" 
                class="input" 
                [(ngModel)]="editingAgent!.description"
                placeholder="Brief description"
              />
            </div>
            
            <div class="form-group">
              <label>System Prompt *</label>
              <textarea 
                class="input" 
                [(ngModel)]="editingAgent!.system_prompt"
                placeholder="Instructions for the agent..."
                rows="6"
              ></textarea>
            </div>
            
            <div class="form-row">
              <div class="form-group">
                <label>Model (Deployment Name) *</label>
                <input 
                  type="text" 
                  class="input" 
                  [(ngModel)]="editingAgent!.model"
                  placeholder="e.g., gpt-4o, gpt-35-turbo"
                  required
                />
                <span class="field-hint">Azure OpenAI deployment name configured in your Azure portal</span>
              </div>
              
              <div class="form-group">
                <label>Temperature</label>
                <input 
                  type="number" 
                  class="input" 
                  [(ngModel)]="editingAgent!.temperature"
                  min="0"
                  max="2"
                  step="0.1"
                />
              </div>
            </div>
            
            <div class="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  [(ngModel)]="editingAgent!.is_orchestrator"
                />
                Is Orchestrator Agent
              </label>
            </div>
            
            <!-- Orchestrator-specific prompts (visible when is_orchestrator is checked) -->
            @if (editingAgent!.is_orchestrator) {
              <div class="orchestrator-prompts">
                <div class="form-group">
                  <label>Analysis Prompt (Phase 1)</label>
                  <textarea 
                    class="input" 
                    [(ngModel)]="editingAgent!.analysis_prompt"
                    placeholder="Prompt for analyzing requests and deciding which specialists to call. Use {agent_list} placeholder for the list of available specialists."
                    rows="8"
                  ></textarea>
                  <span class="field-hint">Instructs the orchestrator how to analyze requests and decide on delegation. Leave blank for default behavior.</span>
                </div>
                
                <div class="form-group">
                  <label>Synthesis Prompt (Phase 3)</label>
                  <textarea 
                    class="input" 
                    [(ngModel)]="editingAgent!.synthesis_prompt"
                    placeholder="Prompt for synthesizing specialist responses into a final answer. Use {specialist_responses} placeholder for the responses."
                    rows="8"
                  ></textarea>
                  <span class="field-hint">Instructs the orchestrator how to combine specialist responses. Leave blank for default behavior.</span>
                </div>
              </div>
            }
            
            <!-- MCP Server Discovery Section -->
            <div class="form-group">
              <label>MCP Server Tools</label>
              
              <!-- Discovery Input -->
              <div class="mcp-discovery">
                <div class="discovery-input-row">
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="mcpServerUrl"
                    placeholder="MCP Server URL (e.g., https://mcp-server.example.com/sse)"
                  />
                  <button 
                    class="btn btn-secondary" 
                    (click)="discoverTools()"
                    [disabled]="!mcpServerUrl || isDiscovering"
                  >
                    <span class="material-icons">{{ isDiscovering ? 'hourglass_empty' : 'search' }}</span>
                    {{ isDiscovering ? 'Discovering...' : 'Discover Tools' }}
                  </button>
                </div>
                
                @if (discoveryError) {
                  <div class="discovery-error">
                    <span class="material-icons">error</span>
                    {{ discoveryError }}
                  </div>
                }
                
                <!-- Discovered Tools Selection -->
                @if (discoveredTools.length > 0) {
                  <div class="discovered-tools">
                    <div class="discovered-header">
                      <span>Discovered {{ discoveredTools.length }} tools from {{ mcpServerUrl }}</span>
                      <button class="btn btn-sm" (click)="selectAllTools()">Select All</button>
                      <button class="btn btn-sm" (click)="clearToolSelection()">Clear</button>
                    </div>
                    <div class="tool-checkboxes">
                      @for (tool of discoveredTools; track tool.name) {
                        <label class="tool-checkbox">
                          <input 
                            type="checkbox" 
                            [checked]="isToolSelected(tool)"
                            (change)="toggleToolSelection(tool)"
                          />
                          <div class="tool-info">
                            <strong>{{ tool.name }}</strong>
                            @if (tool.description) {
                              <span class="tool-desc">{{ tool.description }}</span>
                            }
                          </div>
                        </label>
                      }
                    </div>
                  </div>
                }
              </div>
              
              <!-- Selected Tools Display -->
              @if (editingAgent!.mcp_tools && editingAgent!.mcp_tools.length > 0) {
                <div class="selected-tools">
                  <label>Selected Tools ({{ editingAgent!.mcp_tools.length }})</label>
                  <div class="tools-chips">
                    @for (tool of editingAgent!.mcp_tools; track tool.name; let i = $index) {
                      <div class="tool-chip">
                        <span>{{ tool.name }}</span>
                        <button class="btn-chip-remove" (click)="removeTool(i)">×</button>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn btn-secondary" (click)="closeEditor()">Cancel</button>
            <button 
              class="btn btn-primary" 
              (click)="saveAgent()"
              [disabled]="!isValidAgent()"
            >
              {{ editingAgent?.id ? 'Update' : 'Create' }} Agent
            </button>
          </div>
        </div>
      </div>
      }
      
      <!-- A2A Agent Discovery Modal -->
      @if (showA2AModal) {
        <div class="modal-overlay" (click)="closeA2AModal()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h2>Add External A2A Agent</h2>
              <button class="btn btn-icon" (click)="closeA2AModal()">
                <span class="material-icons">close</span>
              </button>
            </div>
            
            <div class="modal-body">
              <p class="modal-description">
                Connect to an external agent using the A2A (Agent-to-Agent) protocol. 
                Enter the agent's base URL to discover its capabilities.
              </p>
              
              <div class="form-group">
                <label>A2A Agent URL *</label>
                <div class="discovery-input-row">
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="a2aAgentUrl"
                    placeholder="https://example.com/a2a/agent-name"
                  />
                  <button 
                    class="btn btn-secondary" 
                    (click)="discoverA2AAgent()"
                    [disabled]="!a2aAgentUrl || isDiscoveringA2A"
                  >
                    <span class="material-icons">{{ isDiscoveringA2A ? 'hourglass_empty' : 'search' }}</span>
                    {{ isDiscoveringA2A ? 'Discovering...' : 'Discover' }}
                  </button>
                </div>
              </div>
              
              @if (a2aDiscoveryError) {
                <div class="discovery-error">
                  <span class="material-icons">error</span>
                  {{ a2aDiscoveryError }}
                </div>
              }
              
              @if (discoveredA2AAgent) {
                <div class="a2a-preview">
                  <div class="preview-header">
                    <span class="material-icons">cloud</span>
                    <h3>{{ discoveredA2AAgent.name }}</h3>
                  </div>
                  <p class="preview-description">{{ discoveredA2AAgent.description || 'No description provided' }}</p>
                  <div class="preview-meta">
                    <span class="meta-item">
                      <span class="material-icons">extension</span>
                      {{ discoveredA2AAgent.skills_count }} Skills
                    </span>
                    @if (discoveredA2AAgent.card && discoveredA2AAgent.card.version) {
                      <span class="meta-item">
                        <span class="material-icons">tag</span>
                        v{{ discoveredA2AAgent.card.version }}
                      </span>
                    }
                  </div>
                </div>
              }
            </div>
            
            <div class="modal-footer">
              <button class="btn btn-secondary" (click)="closeA2AModal()">Cancel</button>
              <button 
                class="btn btn-primary" 
                (click)="addDiscoveredA2AAgent()"
                [disabled]="!discoveredA2AAgent"
              >
                <span class="material-icons">add</span>
                Add Agent
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .admin-container {
      height: calc(100vh - 56px);
      overflow-y: auto;
      padding: var(--spacing-lg);
    }
    
    .admin-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-lg);
      
      h1 {
        font-size: 24px;
        font-weight: 600;
      }
    }
    
    .header-actions {
      display: flex;
      gap: var(--spacing-sm);
    }
    
    .agents-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: var(--spacing-md);
    }
    
    .agent-card {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: var(--spacing-md);
      
      &.a2a-agent {
        border-color: #6366f1;
        border-style: dashed;
      }
    }
    
    .agent-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }
    
    .agent-icon {
      width: 48px;
      height: 48px;
      border-radius: 8px;
      background-color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      
      &.orchestrator {
        background-color: #10a37f;
      }
      
      &.a2a {
        background-color: #6366f1;
      }
      
      .material-icons {
        color: white;
        font-size: 24px;
      }
    }
    
    .agent-title {
      flex: 1;
      
      h3 {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 2px;
      }
    }
    
    .agent-badge {
      display: inline-block;
      padding: 2px 8px;
      background-color: #10a37f;
      color: white;
      border-radius: 4px;
      font-size: 10px;
      text-transform: uppercase;
      
      &.a2a {
        background-color: #6366f1;
        margin-left: 4px;
      }
    }
    
    .agent-actions {
      display: flex;
      gap: var(--spacing-xs);
    }
    
    .agent-description {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: var(--spacing-md);
    }
    
    .agent-meta {
      display: flex;
      gap: var(--spacing-md);
      flex-wrap: wrap;
      
      .meta-item {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 12px;
        color: var(--text-muted);
        
        .material-icons {
          font-size: 16px;
        }
        
        &.a2a-url {
          flex: 1;
          min-width: 200px;
          background-color: var(--bg-secondary);
          padding: 4px 8px;
          border-radius: 4px;
          
          .url-text {
            font-family: monospace;
            font-size: 11px;
            color: var(--text-secondary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 300px;
          }
          
          .btn-copy {
            display: flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            cursor: pointer;
            padding: 2px;
            border-radius: 4px;
            color: var(--text-muted);
            margin-left: auto;
            
            &:hover {
              background-color: var(--bg-hover);
              color: var(--primary);
            }
            
            .material-icons {
              font-size: 14px;
            }
          }
        }
      }
    }
    
    .empty-state {
      grid-column: 1 / -1;
      text-align: center;
      padding: var(--spacing-xl);
      color: var(--text-muted);
      
      .material-icons {
        font-size: 64px;
        opacity: 0.5;
        margin-bottom: var(--spacing-md);
      }
      
      h3 {
        color: var(--text-secondary);
        margin-bottom: var(--spacing-sm);
      }
    }
    
    // Modal styles
    .modal-overlay {
      position: fixed;
      inset: 0;
      background-color: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .modal {
      background-color: var(--bg-secondary);
      border-radius: 12px;
      width: 100%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
    }
    
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md) var(--spacing-lg);
      border-bottom: 1px solid var(--border-color);
      
      h2 {
        font-size: 18px;
        font-weight: 600;
      }
    }
    
    .modal-body {
      padding: var(--spacing-lg);
    }
    
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
      padding: var(--spacing-md) var(--spacing-lg);
      border-top: 1px solid var(--border-color);
    }
    
    .form-group {
      margin-bottom: var(--spacing-md);
      
      label {
        display: block;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-muted);
        margin-bottom: var(--spacing-xs);
        text-transform: uppercase;
      }
      
      .field-hint {
        display: block;
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 4px;
        font-style: italic;
      }
    }
    
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-md);
    }
    
    .checkbox-group label {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      cursor: pointer;
      text-transform: none;
      
      input {
        width: 16px;
        height: 16px;
      }
    }
    
    .tools-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }
    
    .tool-item {
      display: flex;
      gap: var(--spacing-sm);
      
      input {
        flex: 1;
      }
    }
    
    // MCP Discovery Styles
    .mcp-discovery {
      background-color: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }
    
    .discovery-input-row {
      display: flex;
      gap: var(--spacing-sm);
      
      input {
        flex: 1;
      }
      
      button {
        white-space: nowrap;
      }
    }
    
    .discovery-error {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--error);
      font-size: 12px;
      margin-top: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      background-color: rgba(239, 68, 68, 0.1);
      border-radius: 4px;
    }
    
    .discovered-tools {
      margin-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
      padding-top: var(--spacing-md);
    }
    
    .discovered-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: var(--spacing-sm);
      
      span:first-child {
        flex: 1;
      }
      
      .btn-sm {
        padding: 4px 8px;
        font-size: 11px;
      }
    }
    
    .tool-checkboxes {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      max-height: 200px;
      overflow-y: auto;
    }
    
    .tool-checkbox {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: 4px;
      cursor: pointer;
      text-transform: none;
      
      &:hover {
        background-color: var(--bg-secondary);
      }
      
      input {
        margin-top: 3px;
      }
      
      .tool-info {
        display: flex;
        flex-direction: column;
        
        strong {
          font-size: 13px;
          color: var(--text-primary);
        }
        
        .tool-desc {
          font-size: 11px;
          color: var(--text-muted);
        }
      }
    }
    
    .selected-tools {
      margin-top: var(--spacing-sm);
      
      label {
        margin-bottom: var(--spacing-xs);
      }
    }
    
    .tools-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
    }
    
    .tool-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background-color: var(--primary);
      color: white;
      border-radius: 16px;
      font-size: 12px;
      
      .btn-chip-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: none;
        background: rgba(255, 255, 255, 0.3);
        color: white;
        border-radius: 50%;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        
        &:hover {
          background: rgba(255, 255, 255, 0.5);
        }
      }
    }
    
    /* A2A Modal Styles */
    .modal-description {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: var(--spacing-md);
    }
    
    .a2a-preview {
      background-color: var(--bg-tertiary);
      border: 1px solid #6366f1;
      border-radius: 8px;
      padding: var(--spacing-md);
      margin-top: var(--spacing-md);
      
      .preview-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
        
        .material-icons {
          color: #6366f1;
          font-size: 24px;
        }
        
        h3 {
          font-size: 16px;
          font-weight: 600;
          margin: 0;
        }
      }
      
      .preview-description {
        color: var(--text-secondary);
        font-size: 14px;
        margin-bottom: var(--spacing-sm);
      }
      
      .preview-meta {
        display: flex;
        gap: var(--spacing-md);
        
        .meta-item {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: var(--text-muted);
          
          .material-icons {
            font-size: 16px;
          }
        }
      }
    }
  `]
})
export class AdminComponent implements OnInit, OnDestroy {
  agents: AgentConfig[] = [];
  isLoading = false;
  showEditor = false;
  editingAgent: AgentConfig | null = null;
  
  // MCP Discovery state
  mcpServerUrl = '';
  isDiscovering = false;
  discoveryError = '';
  discoveredTools: MCPToolConfig[] = [];
  
  // A2A Agent Discovery state
  showA2AModal = false;
  a2aAgentUrl = '';
  isDiscoveringA2A = false;
  a2aDiscoveryError = '';
  discoveredA2AAgent: A2ADiscoveryResponse | null = null;
  
  private destroy$ = new Subject<void>();
  
  constructor(private agentService: AgentService) {}
  
  ngOnInit(): void {
    this.loadAgents();
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  loadAgents(): void {
    this.isLoading = true;
    // Use admin endpoint to get full agent configs
    this.agentService.loadAgentsAdmin()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.agents = response.agents;
          this.isLoading = false;
        },
        error: (err) => {
          console.error('Failed to load agents:', err);
          this.isLoading = false;
        }
      });
  }
  
  openEditor(agent?: AgentConfig): void {
    this.editingAgent = agent ? { ...agent, mcp_tools: [...(agent.mcp_tools || [])] } : {
      name: '',
      description: '',
      system_prompt: '',
      model: '',
      temperature: 0.7,
      is_orchestrator: false,
      a2a_enabled: true,
      analysis_prompt: '',
      synthesis_prompt: '',
      mcp_tools: []
    };
    // Reset discovery state when opening editor
    this.mcpServerUrl = '';
    this.discoveredTools = [];
    this.discoveryError = '';
    this.showEditor = true;
  }
  
  closeEditor(): void {
    this.showEditor = false;
    this.editingAgent = null;
    this.discoveredTools = [];
    this.mcpServerUrl = '';
    this.discoveryError = '';
  }
  
  editAgent(agent: AgentConfig): void {
    this.openEditor(agent);
  }
  
  deleteAgent(agentId: string): void {
    if (confirm('Are you sure you want to delete this agent?')) {
      this.agentService.deleteAgent(agentId)
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => {
          this.agents = this.agents.filter(a => a.id !== agentId);
        });
    }
  }
  
  saveAgent(): void {
    if (!this.editingAgent || !this.isValidAgent()) return;
    
    const operation = this.editingAgent.id
      ? this.agentService.updateAgent(this.editingAgent.id, this.editingAgent)
      : this.agentService.createAgent(this.editingAgent);
    
    operation.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.closeEditor();
        this.loadAgents();
      },
      error: (err) => {
        console.error('Failed to save agent:', err);
      }
    });
  }
  
  isValidAgent(): boolean {
    if (!this.editingAgent?.name?.trim()) return false;
    
    // A2A agents don't need system_prompt or model
    if (this.editingAgent.agent_type === 'a2a') {
      return !!this.editingAgent.a2a_url?.trim();
    }
    
    // Local agents require system_prompt AND model (deployment name)
    return !!this.editingAgent.system_prompt?.trim() && !!this.editingAgent.model?.trim();
  }
  
  // =========================================================================
  // MCP Tool Discovery Methods
  // =========================================================================
  
  discoverTools(): void {
    if (!this.mcpServerUrl || this.isDiscovering) return;
    
    this.isDiscovering = true;
    this.discoveryError = '';
    this.discoveredTools = [];
    
    this.agentService.discoverMcpTools({ url: this.mcpServerUrl })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.isDiscovering = false;
          if (response.error) {
            this.discoveryError = response.error;
          } else {
            this.discoveredTools = response.tools;
            if (this.discoveredTools.length === 0) {
              this.discoveryError = 'No tools found at this MCP server';
            }
          }
        },
        error: (err) => {
          this.isDiscovering = false;
          this.discoveryError = err.error?.detail || err.message || 'Failed to discover tools';
          console.error('MCP discovery error:', err);
        }
      });
  }
  
  isToolSelected(tool: MCPToolConfig): boolean {
    if (!this.editingAgent?.mcp_tools) return false;
    return this.editingAgent.mcp_tools.some(t => t.name === tool.name && t.server_url === tool.server_url);
  }
  
  toggleToolSelection(tool: MCPToolConfig): void {
    if (!this.editingAgent) return;
    
    if (!this.editingAgent.mcp_tools) {
      this.editingAgent.mcp_tools = [];
    }
    
    const index = this.editingAgent.mcp_tools.findIndex(
      t => t.name === tool.name && t.server_url === tool.server_url
    );
    
    if (index >= 0) {
      // Remove if already selected
      this.editingAgent.mcp_tools.splice(index, 1);
    } else {
      // Add if not selected
      this.editingAgent.mcp_tools.push({ ...tool });
    }
  }
  
  selectAllTools(): void {
    if (!this.editingAgent) return;
    
    if (!this.editingAgent.mcp_tools) {
      this.editingAgent.mcp_tools = [];
    }
    
    // Add all discovered tools that aren't already selected
    for (const tool of this.discoveredTools) {
      if (!this.isToolSelected(tool)) {
        this.editingAgent.mcp_tools.push({ ...tool });
      }
    }
  }
  
  clearToolSelection(): void {
    if (!this.editingAgent?.mcp_tools) return;
    
    // Remove tools from the current server URL
    this.editingAgent.mcp_tools = this.editingAgent.mcp_tools.filter(
      t => t.server_url !== this.mcpServerUrl
    );
  }
  
  removeTool(index: number): void {
    if (!this.editingAgent?.mcp_tools) return;
    this.editingAgent.mcp_tools.splice(index, 1);
  }
  
  // =========================================================================
  // A2A Agent Discovery Methods
  // =========================================================================
  
  copiedAgentId: string | null = null;
  
  getAgentA2AUrl(agent: AgentConfig): string {
    // Build the A2A base URL for local agents (A2A clients append /.well-known/agent.json)
    // Use backendUrl in dev (different port), window.location.origin in prod (same origin)
    const baseUrl = environment.backendUrl || window.location.origin;
    return `${baseUrl}/a2a/${agent.id}`;
  }
  
  copyA2AUrl(agent: AgentConfig, event: Event): void {
    event.stopPropagation();
    const url = this.getAgentA2AUrl(agent);
    navigator.clipboard.writeText(url).then(() => {
      this.copiedAgentId = agent.id || null;
      // Reset after 2 seconds
      setTimeout(() => {
        this.copiedAgentId = null;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy URL:', err);
    });
  }
  
  openA2AModal(): void {
    this.showA2AModal = true;
    this.a2aAgentUrl = '';
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
    this.isDiscoveringA2A = false;
  }
  
  closeA2AModal(): void {
    this.showA2AModal = false;
    this.a2aAgentUrl = '';
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
  }
  
  discoverA2AAgent(): void {
    if (!this.a2aAgentUrl || this.isDiscoveringA2A) return;
    
    this.isDiscoveringA2A = true;
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
    
    this.agentService.discoverA2AAgent({ url: this.a2aAgentUrl })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.isDiscoveringA2A = false;
          if (response.error) {
            this.a2aDiscoveryError = response.error;
          } else {
            this.discoveredA2AAgent = response;
          }
        },
        error: (err) => {
          this.isDiscoveringA2A = false;
          this.a2aDiscoveryError = err.error?.detail || err.message || 'Failed to discover A2A agent';
          console.error('A2A discovery error:', err);
        }
      });
  }
  
  addDiscoveredA2AAgent(): void {
    if (!this.discoveredA2AAgent || !this.a2aAgentUrl) return;
    
    this.agentService.addA2AAgent({ url: this.a2aAgentUrl })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.closeA2AModal();
          this.loadAgents();
        },
        error: (err) => {
          this.a2aDiscoveryError = err.error?.detail || err.message || 'Failed to add A2A agent';
          console.error('Failed to add A2A agent:', err);
        }
      });
  }
}
