import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatBadgeModule } from '@angular/material/badge';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

interface MCPToolsResponse {
  total_count: number;
  tools: Array<{
    name: string;
    description: string;
    input_schema: any;
  }>;
  tools_by_category: {
    [category: string]: {
      count: number;
      tools: string[];
    };
  };
  server_name: string;
  timestamp: string;
}

interface AgentInfo {
  name: string;
  description: string;
  endpoint: string;
  tools: string[];
  toolCount: number;
  category?: string;
}

@Component({
  selector: 'app-mcp-tools-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatBadgeModule,
  ],
  template: `
    <div class="mcp-tools-dialog">
      <h2 mat-dialog-title>
        <mat-icon>extension</mat-icon>
        MCP Tools & Agents
      </h2>

      <mat-dialog-content>
        @if (loading) {
          <div class="loading-container">
            <mat-spinner diameter="50"></mat-spinner>
            <p>Loading MCP tools and agent information...</p>
          </div>
        } @else if (error) {
          <div class="error-container">
            <mat-icon color="warn">error</mat-icon>
            <p>{{ error }}</p>
            <button mat-raised-button color="primary" (click)="loadData()">
              <mat-icon>refresh</mat-icon>
              Retry
            </button>
          </div>
        } @else {
          <!-- Server Info -->
          <div class="server-info">
            <div class="info-item">
              <mat-icon>dns</mat-icon>
              <span><strong>Server:</strong> {{ mcpData?.server_name || 'Unknown' }}</span>
            </div>
            <div class="info-item">
              <mat-icon>extension</mat-icon>
              <span><strong>Total Tools:</strong> {{ mcpData?.total_count || 0 }}</span>
            </div>
            <div class="info-item">
              <mat-icon>schedule</mat-icon>
              <span><strong>Updated:</strong> {{ formatTimestamp(mcpData?.timestamp) }}</span>
            </div>
          </div>

          <!-- Tools by Category -->
          <div class="section">
            <h3>
              <mat-icon>category</mat-icon>
              Tools by Category
            </h3>
            <div class="category-chips">
              @for (category of getCategories(); track category) {
                <mat-chip 
                  [matBadge]="mcpData!.tools_by_category[category]?.count || 0"
                  matBadgeColor="accent"
                  matBadgeSize="small">
                  {{ category }}
                </mat-chip>
              }
            </div>
          </div>

          <!-- Agents and Their Tools -->
          <div class="section">
            <h3>
              <mat-icon>groups</mat-icon>
              Agents & Capabilities
            </h3>
            <mat-accordion>
              @for (agent of agents; track agent.name) {
                <mat-expansion-panel>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <div class="agent-header">
                        <mat-icon [class]="'agent-icon ' + getAgentIconClass(agent.name)">
                          {{ getAgentIcon(agent.name) }}
                        </mat-icon>
                        <span class="agent-name">{{ agent.name }}</span>
                        <mat-chip class="tool-count">{{ agent.toolCount }} tools</mat-chip>
                      </div>
                    </mat-panel-title>
                  </mat-expansion-panel-header>

                  <div class="agent-details">
                    <p class="agent-description">{{ agent.description }}</p>
                    
                    <div class="endpoint-info">
                      <mat-icon>link</mat-icon>
                      <code>{{ agent.endpoint }}</code>
                    </div>

                    <div class="tools-list">
                      <h4>Available Tools:</h4>
                      <div class="tool-chips">
                        @for (tool of agent.tools; track tool) {
                          <mat-chip class="tool-chip">
                            <mat-icon>build</mat-icon>
                            {{ tool }}
                          </mat-chip>
                        }
                      </div>
                    </div>
                  </div>
                </mat-expansion-panel>
              }
            </mat-accordion>
          </div>

          <!-- All Available Tools (Flat List) -->
          <div class="section">
            <h3>
              <mat-icon>build_circle</mat-icon>
              All Available Tools ({{ mcpData?.tools?.length || 0 }})
            </h3>
            <div class="all-tools-grid">
              @for (tool of mcpData?.tools; track tool.name) {
                <div class="tool-card">
                  <div class="tool-header">
                    <mat-icon>build</mat-icon>
                    <strong>{{ tool.name }}</strong>
                  </div>
                  @if (tool.description && tool.description !== 'No description available') {
                    <p class="tool-description">{{ tool.description }}</p>
                  }
                  <span class="tool-category">{{ getToolCategory(tool.name) }}</span>
                </div>
              }
            </div>
          </div>
        }
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="close()">Close</button>
        <button mat-raised-button color="primary" (click)="loadData()">
          <mat-icon>refresh</mat-icon>
          Refresh
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .mcp-tools-dialog {
      width: 90vw;
      max-width: 1000px;
      max-height: 90vh;

      h2 {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0;
        color: #667eea;

        mat-icon {
          font-size: 28px;
          width: 28px;
          height: 28px;
        }
      }
    }

    mat-dialog-content {
      max-height: 70vh;
      overflow-y: auto;
      padding: 20px;
    }

    .loading-container,
    .error-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      gap: 20px;

      mat-icon {
        font-size: 48px;
        width: 48px;
        height: 48px;
      }

      p {
        font-size: 16px;
        color: #666;
        margin: 0;
      }
    }

    .server-info {
      display: flex;
      gap: 24px;
      padding: 16px;
      background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
      border-radius: 8px;
      margin-bottom: 24px;
      flex-wrap: wrap;

      .info-item {
        display: flex;
        align-items: center;
        gap: 8px;

        mat-icon {
          color: #667eea;
          font-size: 20px;
          width: 20px;
          height: 20px;
        }

        span {
          font-size: 14px;
        }
      }
    }

    .section {
      margin-bottom: 32px;

      h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 16px;
        color: #333;

        mat-icon {
          color: #667eea;
          font-size: 24px;
          width: 24px;
          height: 24px;
        }
      }
    }

    .category-chips {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;

      mat-chip {
        font-weight: 500;
        text-transform: capitalize;
      }
    }

    .agent-header {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;

      .agent-icon {
        font-size: 24px;
        width: 24px;
        height: 24px;

        &.adx-icon { color: #0078d4; }
        &.fictional-icon { color: #ff6b6b; }
        &.document-icon { color: #4ecdc4; }
        &.investigator-icon { color: #95e1d3; }
        &.default-icon { color: #667eea; }
      }

      .agent-name {
        font-size: 16px;
        font-weight: 600;
        flex: 1;
      }

      .tool-count {
        font-size: 12px;
      }
    }

    .agent-details {
      padding: 16px 0;

      .agent-description {
        color: #666;
        margin-bottom: 16px;
        line-height: 1.5;
      }

      .endpoint-info {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px;
        background: #f5f5f5;
        border-radius: 6px;
        margin-bottom: 16px;

        mat-icon {
          color: #667eea;
          font-size: 18px;
          width: 18px;
          height: 18px;
        }

        code {
          font-size: 13px;
          color: #333;
          background: transparent;
        }
      }

      .tools-list {
        h4 {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 12px;
          color: #333;
        }

        .tool-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;

          .tool-chip {
            font-size: 12px;
            height: 28px;

            mat-icon {
              font-size: 16px;
              width: 16px;
              height: 16px;
              margin-right: 4px;
            }
          }
        }
      }
    }

    .all-tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 16px;

      .tool-card {
        padding: 16px;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: white;
        transition: all 0.2s;

        &:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          border-color: #667eea;
        }

        .tool-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;

          mat-icon {
            color: #667eea;
            font-size: 20px;
            width: 20px;
            height: 20px;
          }

          strong {
            font-size: 14px;
            color: #333;
          }
        }

        .tool-description {
          font-size: 13px;
          color: #666;
          margin: 8px 0;
          line-height: 1.4;
        }

        .tool-category {
          display: inline-block;
          font-size: 11px;
          padding: 4px 8px;
          background: #667eea15;
          color: #667eea;
          border-radius: 12px;
          text-transform: capitalize;
        }
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;
      border-top: 1px solid #e0e0e0;

      button {
        mat-icon {
          margin-right: 4px;
        }
      }
    }
  `],
})
export class McpToolsDialogComponent implements OnInit {
  private http = inject(HttpClient);
  private dialogRef = inject(MatDialogRef<McpToolsDialogComponent>);

  loading = true;
  error: string | null = null;
  mcpData: MCPToolsResponse | null = null;
  agents: AgentInfo[] = [];

  // Well-known agent endpoints
  private readonly agentEndpoints = [
    {
      name: 'ADXAgent',
      endpoint: `${environment.api.baseUrl.replace('/api', '')}/agents/adx/a2a`,
      description: 'Azure Data Explorer specialist for querying Kusto databases and analyzing structured data',
      category: 'adx',
    },
    {
      name: 'FictionalCompaniesAgent',
      endpoint: `${environment.api.baseUrl.replace('/api', '')}/agents/fictional/a2a`,
      description: 'Provides fictional company information including devices, summaries, and IP-based lookups',
      category: 'fictional_api',
    },
    {
      name: 'DocumentAgent',
      endpoint: `${environment.api.baseUrl.replace('/api', '')}/agents/document/a2a`,
      description: 'Manages and searches documents in Azure Blob Storage and AI Search',
      category: 'document',
    },
    {
      name: 'InvestigatorAgent',
      endpoint: `${environment.api.baseUrl.replace('/api', '')}/agents/investigator/a2a`,
      description: 'RAG-based question answering and information retrieval specialist',
      category: 'rag',
    },
  ];

  ngOnInit() {
    this.loadData();
  }

  async loadData() {
    this.loading = true;
    this.error = null;

    try {
      // Fetch MCP tools data from the MCP server
      const response = await this.http
        .get<MCPToolsResponse>(`${environment.azure.functions.mcpServerUrl}/tools`)
        .toPromise();

      this.mcpData = response || null;

      // Map agents to their tools using categories
      this.agents = this.agentEndpoints.map((agent) => {
        const category = this.mcpData?.tools_by_category[agent.category];
        return {
          name: agent.name,
          description: agent.description,
          endpoint: agent.endpoint,
          tools: category?.tools || [],
          toolCount: category?.count || 0,
          category: agent.category,
        };
      });

      this.loading = false;
    } catch (err: any) {
      console.error('Error loading MCP tools:', err);
      this.error = err.message || 'Failed to load MCP tools and agent information';
      this.loading = false;
    }
  }

  getCategories(): string[] {
    if (!this.mcpData?.tools_by_category) return [];
    return Object.keys(this.mcpData.tools_by_category);
  }

  getToolCategory(toolName: string): string {
    if (!this.mcpData?.tools_by_category) return 'unknown';

    for (const [category, data] of Object.entries(this.mcpData.tools_by_category)) {
      if (data.tools.includes(toolName)) {
        return category;
      }
    }
    return 'unknown';
  }

  getAgentIcon(agentName: string): string {
    const icons: { [key: string]: string } = {
      ADXAgent: 'storage',
      FictionalCompaniesAgent: 'business',
      DocumentAgent: 'description',
      InvestigatorAgent: 'search',
    };
    return icons[agentName] || 'smart_toy';
  }

  getAgentIconClass(agentName: string): string {
    const classes: { [key: string]: string } = {
      ADXAgent: 'adx-icon',
      FictionalCompaniesAgent: 'fictional-icon',
      DocumentAgent: 'document-icon',
      InvestigatorAgent: 'investigator-icon',
    };
    return classes[agentName] || 'default-icon';
  }

  formatTimestamp(timestamp?: string): string {
    if (!timestamp) return 'Unknown';
    try {
      const date = new Date(timestamp);
      return date.toLocaleString();
    } catch {
      return timestamp;
    }
  }

  close() {
    this.dialogRef.close();
  }
}
