import { Component, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AgentConfig } from '../../../../core/services/agent.service';

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="agent-selector" [class.collapsed]="isCollapsed">
      <div class="selector-header" (click)="isCollapsed = !isCollapsed">
        <div class="header-left">
          <h3>Configure Agents</h3>
          <p class="text-muted">Select agents and orchestration pattern for this conversation.</p>
        </div>
        <button class="btn btn-icon collapse-toggle" [title]="isCollapsed ? 'Expand' : 'Collapse'">
          <span class="material-icons">{{ isCollapsed ? 'expand_more' : 'expand_less' }}</span>
        </button>
      </div>
      
      @if (!isCollapsed) {
        <div class="selector-controls">
          <div class="orchestration-select">
            <label>Orchestration Pattern</label>
            <select 
              class="input" 
              [ngModel]="orchestrationType"
              (ngModelChange)="orchestrationChange.emit($event)"
            >
              <option value="single">Single Agent</option>
              <option value="sequential">Sequential (Chain)</option>
              <option value="concurrent">Concurrent (Parallel)</option>
              <option value="magentic">Magentic-One</option>
              <option value="group_chat">Group Chat</option>
            </select>
          </div>
          
          @if (agents.length > 6) {
            <div class="agent-search">
              <span class="material-icons">search</span>
              <input 
                type="text" 
                class="input filter-input" 
                [(ngModel)]="agentFilter"
                placeholder="Filter agents..."
                (click)="$event.stopPropagation()"
              />
            </div>
          }
        </div>
        
        <div class="agents-grid">
          @for (agent of filteredSortedAgents; track agent.id) {
            <div 
              class="agent-card"
              [class.selected]="isSelected(agent.id!) || agent.is_orchestrator"
              [class.orchestrator]="agent.is_orchestrator"
              [class.locked]="agent.is_orchestrator"
              [class.a2a]="agent.agent_type === 'a2a'"
              [title]="agent.description || agent.name"
              (click)="!agent.is_orchestrator && agentToggle.emit(agent.id!)"
            >
              <div class="agent-icon">
                <span class="material-icons">
                  {{ agent.is_orchestrator ? 'hub' : (agent.agent_type === 'a2a' ? 'cloud' : 'smart_toy') }}
                </span>
              </div>
              <div class="agent-info">
                <div class="agent-name">
                  {{ agent.name }}
                  @if (agent.agent_type === 'a2a') {
                    <span class="a2a-badge">A2A</span>
                  }
                </div>
                <div class="agent-description">{{ agent.description }}</div>
                @if (agent.model) {
                  <div class="agent-model">{{ agent.model }}</div>
                } @else if (agent.agent_type === 'a2a') {
                  <div class="agent-model a2a-external">External Agent</div>
                }
                @if (agent.is_orchestrator) {
                  <div class="agent-required">Required</div>
                }
              </div>
              @if (isSelected(agent.id!) || agent.is_orchestrator) {
                <div class="agent-check">
                  <span class="material-icons">{{ agent.is_orchestrator ? 'lock' : 'check_circle' }}</span>
                </div>
              }
            </div>
          }
          
          @if (agents.length === 0) {
            <div class="no-agents">
              <span class="material-icons">warning</span>
              <p>No agents configured. Go to Admin to create agents.</p>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .agent-selector {
      padding: var(--spacing-lg);
      border-bottom: 1px solid var(--border-color);
      background-color: var(--bg-secondary);
      transition: all 0.2s ease;
      
      &.collapsed {
        padding-bottom: var(--spacing-sm);
      }
    }
    
    .selector-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: var(--spacing-md);
      cursor: pointer;
      
      .header-left {
        flex: 1;
      }
      
      h3 {
        font-size: 18px;
        font-weight: 600;
        margin-bottom: var(--spacing-xs);
      }
      
      .collapsed & {
        margin-bottom: 0;
      }
    }
    
    .collapse-toggle {
      flex-shrink: 0;
      opacity: 0.6;
      
      &:hover {
        opacity: 1;
      }
    }
    
    .selector-controls {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
    }
    
    .orchestration-select {
      max-width: 300px;
      
      label {
        display: block;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-muted);
        margin-bottom: var(--spacing-xs);
        text-transform: uppercase;
      }
      
      select {
        cursor: pointer;
      }
    }
    
    .agent-search {
      display: flex;
      align-items: center;
      gap: 6px;
      background-color: var(--input-bg, var(--bg-tertiary));
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 0 var(--spacing-sm);
      
      .material-icons {
        font-size: 18px;
        color: var(--text-muted);
      }
      
      .filter-input {
        border: none;
        background: transparent;
        width: 180px;
        padding: 6px 0;
        
        &:focus {
          border: none;
          outline: none;
        }
      }
    }
    
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: var(--spacing-md);
      max-height: 50vh;
      overflow-y: auto;
      padding: 2px;
    }
    
    .agent-card {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      background-color: var(--bg-tertiary);
      border: 2px solid transparent;
      border-radius: 8px;
      cursor: pointer;
      transition: all var(--transition-fast);
      
      &:hover {
        background-color: var(--bg-hover);
      }
      
      &.selected {
        border-color: var(--primary);
        background-color: rgba(0, 120, 212, 0.1);
      }
      
      &.orchestrator {
        .agent-icon {
          background-color: #10a37f;
        }
      }
      
      &.a2a {
        .agent-icon {
          background-color: #7c3aed;
        }
      }
      
      &.locked {
        cursor: default;
        border-color: #10a37f;
        background-color: rgba(16, 163, 127, 0.1);
        
        &:hover {
          background-color: rgba(16, 163, 127, 0.1);
        }
        
        .agent-check .material-icons {
          color: #10a37f;
        }
      }
    }
    
    .agent-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background-color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      
      .material-icons {
        color: white;
        font-size: 20px;
      }
    }
    
    .agent-info {
      flex: 1;
      min-width: 0;
    }
    
    .agent-name {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
      
      .a2a-badge {
        font-size: 9px;
        font-weight: 600;
        padding: 2px 5px;
        border-radius: 3px;
        background-color: #7c3aed;
        color: white;
        text-transform: uppercase;
      }
    }
    
    .agent-description {
      font-size: 12px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .agent-model {
      font-size: 11px;
      color: var(--primary);
      margin-top: 2px;
      
      &.a2a-external {
        color: #7c3aed;
      }
    }
    
    .agent-required {
      font-size: 10px;
      font-weight: 600;
      color: #10a37f;
      text-transform: uppercase;
      margin-top: 2px;
    }
    
    .agent-check {
      flex-shrink: 0;
      
      .material-icons {
        color: var(--primary);
        font-size: 24px;
      }
    }
    
    .no-agents {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-lg);
      background-color: var(--bg-tertiary);
      border-radius: 8px;
      color: var(--text-muted);
      
      .material-icons {
        font-size: 24px;
        color: var(--warning);
      }
    }
  `]
})
export class AgentSelectorComponent {
  @Input() agents: AgentConfig[] = [];
  @Input() selectedAgentIds: string[] = [];
  @Input() orchestrationType = 'sequential';
  
  @Output() agentToggle = new EventEmitter<string>();
  @Output() orchestrationChange = new EventEmitter<string>();
  
  isCollapsed = false;
  agentFilter = '';

  get sortedAgents(): AgentConfig[] {
    return [...this.agents].sort((a, b) => {
      if (a.is_orchestrator && !b.is_orchestrator) return -1;
      if (!a.is_orchestrator && b.is_orchestrator) return 1;
      return 0;
    });
  }
  
  get filteredSortedAgents(): AgentConfig[] {
    if (!this.agentFilter.trim()) return this.sortedAgents;
    const term = this.agentFilter.toLowerCase();
    return this.sortedAgents.filter(a =>
      a.name.toLowerCase().includes(term) ||
      (a.description || '').toLowerCase().includes(term)
    );
  }
  
  isSelected(agentId: string): boolean {
    return this.selectedAgentIds.includes(agentId);
  }
}
