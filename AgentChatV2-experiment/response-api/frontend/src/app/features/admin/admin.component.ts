import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';

import { AgentService, AgentConfig, MCPToolConfig, A2ADiscoveryResponse, GroundingSource, GroundingStatusResponse, ReindexResponse, AOAIEndpointConfig, AOAIDeploymentOption, SearchIndexInfo } from '../../core/services/agent.service';
import { SettingsService, UISettings, ClassificationBanner } from '../../core/services/settings.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="admin-container">
      <div class="admin-header">
        <h1>Administration</h1>
      </div>

      <!-- Agents Section -->
      <div class="agents-section">
        <div class="section-header">
          <h2>
            <span class="material-icons">smart_toy</span>
            Agents
          </h2>
          <div class="header-actions">
            <div class="search-filter">
              <span class="material-icons">search</span>
              <input 
                type="text" 
                class="input filter-input" 
                [(ngModel)]="agentFilter"
                placeholder="Filter agents..."
              />
            </div>
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
        @for (agent of filteredAgents; track agent.id) {
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
                <button class="btn btn-icon btn-edit" (click)="editAgent(agent)" title="Edit" [disabled]="agent.agent_type === 'a2a'">
                  <span class="material-icons">edit</span>
                </button>
                <button class="btn btn-icon btn-delete" (click)="deleteAgent(agent.id!)" title="Delete">
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
                @if (agent.grounding_sources && agent.grounding_sources.length > 0) {
                  <span class="meta-item" title="Document grounding sources for RAG">
                    <span class="material-icons">library_books</span>
                    {{ agent.grounding_sources.length }} Doc Sources
                  </span>
                }
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
      </div>
      
      <!-- Azure OpenAI Endpoints Section -->
      <div class="aoai-section">
        <div class="section-header">
          <h2>
            <span class="material-icons">cloud</span>
            Azure OpenAI Endpoints
          </h2>
          <button class="btn btn-primary btn-sm" (click)="openAoaiEditor()">
            <span class="material-icons">add</span>
            Add Endpoint
          </button>
        </div>
        
        <div class="endpoints-list">
          @for (endpoint of aoaiEndpoints; track endpoint.id) {
            <div class="endpoint-card">
              <div class="endpoint-info">
                <div class="endpoint-name">
                  <strong>{{ endpoint.name }}</strong>
                  @if (!endpoint.is_active) {
                    <span class="badge inactive">Inactive</span>
                  }
                </div>
                <div class="endpoint-url">{{ endpoint.endpoint }}</div>
                <div class="endpoint-meta">
                  <span class="meta-item">
                    <span class="material-icons">cloud</span>
                    {{ getCloudLabel(endpoint.endpoint, endpoint.endpoint_type) }}
                  </span>
                  <span class="meta-item">
                    <span class="material-icons">memory</span>
                    {{ endpoint.deployments?.length || 0 }} Deployments
                  </span>
                  @if (endpoint.last_discovered_at) {
                    <span class="meta-item">
                      <span class="material-icons">schedule</span>
                      Last refreshed: {{ formatDate(endpoint.last_discovered_at) }}
                    </span>
                  }
                </div>
              </div>
              <div class="endpoint-actions">
                @if (!isApimType(endpoint.endpoint_type)) {
                <button class="btn btn-icon btn-refresh" (click)="refreshAoaiEndpoint(endpoint)" title="Refresh Deployments">
                  <span class="material-icons">refresh</span>
                </button>
                }
                <button class="btn btn-icon btn-edit" (click)="editAoaiEndpoint(endpoint)" title="Edit">
                  <span class="material-icons">edit</span>
                </button>
                <button class="btn btn-icon btn-delete" (click)="deleteAoaiEndpoint(endpoint.id!)" title="Delete">
                  <span class="material-icons">delete</span>
                </button>
              </div>
            </div>
          }
          
          @if (aoaiEndpoints.length === 0) {
            <div class="empty-state small">
              <span class="material-icons">cloud_off</span>
              <p>No Azure OpenAI endpoints configured. Add an endpoint to enable model deployment selection.</p>
            </div>
          }
        </div>
      </div>
      
      <!-- UI Settings Section -->
      <div class="ui-settings-section">
        <div class="section-header">
          <h2>
            <span class="material-icons">palette</span>
            UI Settings
          </h2>
        </div>
        
        <div class="settings-card">
          <!-- Classification Banner -->
          <div class="settings-group">
            <h3>
              <span class="material-icons">security</span>
              Classification Banner
            </h3>
            <p class="settings-description">Display a classification banner at the top of the application.</p>
            
            <div class="form-group checkbox-group">
              <label>
                <input 
                  type="checkbox" 
                  [(ngModel)]="uiSettings.classification_banner.enabled"
                  (ngModelChange)="onSettingsChanged()"
                />
                Enable Classification Banner
              </label>
            </div>
            
            @if (uiSettings.classification_banner.enabled) {
              <div class="form-group">
                <label>Banner Text</label>
                <input 
                  type="text" 
                  class="input" 
                  [(ngModel)]="uiSettings.classification_banner.text"
                  (ngModelChange)="onSettingsChanged()"
                  placeholder="e.g., UNCLASSIFIED, CUI, SECRET"
                  maxlength="200"
                />
              </div>
              
              <div class="form-row">
                <div class="form-group">
                  <label>Background Color</label>
                  <div class="color-picker-row">
                    <input 
                      type="color" 
                      [(ngModel)]="uiSettings.classification_banner.background_color"
                      (ngModelChange)="onSettingsChanged()"
                      class="color-input"
                    />
                    <input 
                      type="text" 
                      class="input color-text-input" 
                      [(ngModel)]="uiSettings.classification_banner.background_color"
                      (ngModelChange)="onSettingsChanged()"
                      placeholder="#007a33"
                    />
                  </div>
                </div>
                
                <div class="form-group">
                  <label>Text Color</label>
                  <div class="color-picker-row">
                    <input 
                      type="color" 
                      [(ngModel)]="uiSettings.classification_banner.foreground_color"
                      (ngModelChange)="onSettingsChanged()"
                      class="color-input"
                    />
                    <input 
                      type="text" 
                      class="input color-text-input" 
                      [(ngModel)]="uiSettings.classification_banner.foreground_color"
                      (ngModelChange)="onSettingsChanged()"
                      placeholder="#ffffff"
                    />
                  </div>
                </div>
              </div>
              
              <!-- Banner Preview -->
              <div class="banner-preview-container">
                <label>Preview</label>
                <div 
                  class="banner-preview"
                  [style.backgroundColor]="uiSettings.classification_banner.background_color"
                  [style.color]="uiSettings.classification_banner.foreground_color"
                >
                  {{ uiSettings.classification_banner.text || 'UNCLASSIFIED' }}
                </div>
              </div>
            }
          </div>
          
          <!-- Application Branding -->
          <div class="settings-group">
            <h3>
              <span class="material-icons">brush</span>
              Application Branding
            </h3>
            <p class="settings-description">Customize the look of your application with a logo and title.</p>
            
            <div class="form-group">
              <label>Application Title</label>
              <input 
                type="text" 
                class="input" 
                [(ngModel)]="uiSettings.app_title"
                (ngModelChange)="onSettingsChanged()"
                placeholder="Agent Chat (default)"
                maxlength="100"
              />
              <span class="field-hint">Shown in the sidebar header. Leave blank to use default.</span>
            </div>

            <div class="form-group">
              <label>Assistant Display Name</label>
              <input 
                type="text" 
                class="input" 
                [(ngModel)]="uiSettings.assistant_display_name"
                (ngModelChange)="onSettingsChanged()"
                placeholder="Assistant (default)"
                maxlength="100"
              />
              <span class="field-hint">Shown above assistant messages in chat. Leave blank to use "Assistant".</span>
            </div>
            
            <div class="form-group">
              <label>Branding Logo</label>
              <div class="image-upload-area"
                (dragover)="onDragOver($event)"
                (dragleave)="onDragLeave($event)"
                (drop)="onDrop($event)"
              >
                @if (brandingImagePreview) {
                  <div class="image-preview">
                    <img [src]="brandingImagePreview" alt="Branding preview" />
                    <button class="btn btn-icon remove-image" (click)="removeBrandingImage()" title="Remove image">
                      <span class="material-icons">close</span>
                    </button>
                  </div>
                } @else {
                  <div class="upload-placeholder" [class.drag-over]="isDragging" (click)="brandingFileInput.click()">
                    <span class="material-icons">cloud_upload</span>
                    <p>{{ isDragging ? 'Drop image here' : 'Click or drag & drop a logo image' }}</p>
                    <span class="upload-hint">PNG, JPG, SVG — max 500KB</span>
                  </div>
                }
                <input 
                  type="file" 
                  #brandingFileInput
                  accept="image/png,image/jpeg,image/svg+xml,image/gif,image/webp"
                  (change)="onBrandingImageSelected($event)"
                  style="display: none"
                />
                @if (brandingImagePreview) {
                  <button class="btn btn-secondary btn-sm" (click)="brandingFileInput.click()">
                    <span class="material-icons">swap_horiz</span>
                    Change Image
                  </button>
                }
              </div>
              @if (brandingImageError) {
                <span class="field-error">{{ brandingImageError }}</span>
              }
              @if (uiSettings.branding_image_filename) {
                <span class="field-hint">Current file: {{ uiSettings.branding_image_filename }}</span>
              }
            </div>

            <div class="form-group">
              <label>Logo Position</label>
              <div class="logo-position-options">
                <label class="radio-card" [class.selected]="uiSettings.branding_image_position === 'sidebar'">
                  <input 
                    type="radio" 
                    name="logoPosition" 
                    value="sidebar"
                    [checked]="uiSettings.branding_image_position === 'sidebar'"
                    (change)="uiSettings.branding_image_position = 'sidebar'; onSettingsChanged()"
                  />
                  <span class="material-icons">vertical_split</span>
                  <span class="radio-label">Sidebar</span>
                  <span class="radio-description">Top-left in the sidebar</span>
                </label>
                <label class="radio-card" [class.selected]="uiSettings.branding_image_position === 'header'">
                  <input 
                    type="radio" 
                    name="logoPosition" 
                    value="header"
                    [checked]="uiSettings.branding_image_position === 'header'"
                    (change)="uiSettings.branding_image_position = 'header'; onSettingsChanged()"
                  />
                  <span class="material-icons">web_asset</span>
                  <span class="radio-label">Header</span>
                  <span class="radio-description">Top-center in the header bar</span>
                </label>
              </div>
              <span class="field-hint">Choose where the branding logo appears in the app.</span>
            </div>

            <div class="form-group">
              <label>Browser Icon (Favicon)</label>
              <p class="field-hint" style="margin-bottom: 8px;">Custom icon shown in the browser tab. Recommended: 32×32 or 64×64 PNG or ICO.</p>
              <div class="image-upload-area favicon-upload-area"
                (dragover)="onFaviconDragOver($event)"
                (dragleave)="onFaviconDragLeave($event)"
                (drop)="onFaviconDrop($event)"
              >
                @if (faviconImagePreview) {
                  <div class="image-preview favicon-preview">
                    <img [src]="faviconImagePreview" alt="Favicon preview" class="favicon-img" />
                    <button class="btn btn-icon remove-image" (click)="removeFaviconImage()" title="Remove favicon">
                      <span class="material-icons">close</span>
                    </button>
                  </div>
                } @else {
                  <div class="upload-placeholder" [class.drag-over]="isFaviconDragging" (click)="faviconFileInput.click()">
                    <span class="material-icons">tab</span>
                    <p>{{ isFaviconDragging ? 'Drop icon here' : 'Click or drag & drop a favicon' }}</p>
                    <span class="upload-hint">PNG, ICO, SVG — max 100KB, ideally 32×32 or 64×64</span>
                  </div>
                }
                <input 
                  type="file" 
                  #faviconFileInput
                  accept="image/png,image/x-icon,image/svg+xml,image/ico,image/vnd.microsoft.icon"
                  (change)="onFaviconImageSelected($event)"
                  style="display: none"
                />
                @if (faviconImagePreview) {
                  <button class="btn btn-secondary btn-sm" (click)="faviconFileInput.click()">
                    <span class="material-icons">swap_horiz</span>
                    Change Icon
                  </button>
                }
              </div>
              @if (faviconImageError) {
                <span class="field-error">{{ faviconImageError }}</span>
              }
              @if (uiSettings.favicon_image_filename) {
                <span class="field-hint">Current file: {{ uiSettings.favicon_image_filename }}</span>
              }
            </div>
          </div>
          
          <!-- Save Button -->
          <div class="settings-actions">
            <button 
              class="btn btn-primary" 
              (click)="saveUISettings()"
              [disabled]="isSavingSettings || !settingsChanged"
            >
              @if (isSavingSettings) {
                <span class="material-icons spinning">sync</span>
                Saving...
              } @else {
                <span class="material-icons">save</span>
                Save UI Settings
              }
            </button>
            @if (settingsSaveSuccess) {
              <span class="save-success">
                <span class="material-icons">check_circle</span>
                Settings saved successfully
              </span>
            }
            @if (settingsSaveError) {
              <span class="save-error">
                <span class="material-icons">error</span>
                {{ settingsSaveError }}
              </span>
            }
          </div>
        </div>
      </div>
      
      <!-- AOAI Endpoint Editor Modal -->
      @if (showAoaiEditor) {
        <div class="modal-overlay" (mousedown)="onOverlayMouseDown($event)" (click)="onAoaiOverlayClick($event)">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h2>{{ editingAoaiEndpoint?.id ? 'Edit' : 'Add' }} Azure OpenAI Endpoint</h2>
              <button class="btn btn-icon" (click)="closeAoaiEditor()">
                <span class="material-icons">close</span>
              </button>
            </div>
            
            <div class="modal-body">
              <!-- Endpoint Type Selector -->
              <div class="form-group">
                <label>Endpoint Type *</label>
                <select
                  class="input"
                  [(ngModel)]="editingAoaiEndpoint!.endpoint_type"
                >
                  <option value="azure_openai">Direct Azure OpenAI — Chat Completions</option>
                  <option value="apim">API Management (APIM) — Chat Completions</option>
                  <option value="azure_openai_responses">Direct Azure OpenAI — Responses (v1)</option>
                  <option value="apim_responses">API Management (APIM) — Responses (v1)</option>
                </select>
                <span class="field-hint">
                  {{ getEndpointTypeLabel(editingAoaiEndpoint!.endpoint_type) }}
                  @if (isResponsesType(editingAoaiEndpoint!.endpoint_type)) {
                    — uses the OpenAI Responses API surface.
                  } @else {
                    — uses the legacy /chat/completions surface.
                  }
                </span>
              </div>

              <div class="form-group">
                <label>Name *</label>
                <input 
                  type="text" 
                  class="input" 
                  [(ngModel)]="editingAoaiEndpoint!.name"
                  placeholder="e.g., Production AOAI, Dev Endpoint"
                />
              </div>
              
              <div class="form-group">
                <label>{{ isApimType(editingAoaiEndpoint!.endpoint_type) ? 'APIM Base URL *' : 'Endpoint URL *' }}</label>
                <input 
                  type="url" 
                  class="input" 
                  [(ngModel)]="editingAoaiEndpoint!.endpoint"
                  [placeholder]="isApimType(editingAoaiEndpoint!.endpoint_type) ? 'https://your-apim.azure-api.net/your-api-prefix' : 'https://your-aoai.openai.azure.com'"
                />
                <span class="field-hint">
                  @if (isApimType(editingAoaiEndpoint!.endpoint_type)) {
                    @if (isResponsesType(editingAoaiEndpoint!.endpoint_type)) {
                      Full APIM URL <strong>including</strong> the <em>/openai/v1</em> suffix.
                      E.g. <em>https://myapim.azure-api.net/myapi/openai/v1</em>
                    } @else {
                      APIM base URL <strong>without</strong> the /openai suffix (the SDK appends it automatically).
                      E.g. if your APIM request URL is <em>https://myapim.azure-api.net/myapi/openai/deployments/...</em> enter <em>https://myapim.azure-api.net/myapi</em>
                    }
                  } @else {
                    Azure OpenAI endpoint URL from Azure Portal
                  }
                </span>
              </div>
              
              <div class="form-row">
                <div class="form-group">
                  <label>API Version</label>
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="editingAoaiEndpoint!.api_version"
                    placeholder="2024-02-15-preview"
                  />
                </div>
              </div>
              
              <div class="form-row">
                <div class="form-group">
                  <label>{{ isApimType(editingAoaiEndpoint!.endpoint_type) ? 'APIM Subscription Key' : 'API Key (Optional)' }}</label>
                  <input 
                    type="password" 
                    class="input" 
                    [(ngModel)]="editingAoaiEndpoint!.api_key"
                    [placeholder]="isApimType(editingAoaiEndpoint!.endpoint_type) ? 'APIM subscription key (api-key header)' : 'Uses managed identity if blank'"
                  />
                  @if (isApimType(editingAoaiEndpoint!.endpoint_type)) {
                    <span class="field-hint">Sent as the <code>api-key</code> header to APIM</span>
                  }
                </div>
              </div>
              
              <!-- ARM API info for deployment discovery (only for direct Azure OpenAI) -->
              @if (!isApimType(editingAoaiEndpoint!.endpoint_type)) {
              <div class="form-row">
                <div class="form-group">
                  <label>Subscription ID</label>
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="editingAoaiEndpoint!.subscription_id"
                    placeholder="e.g., 12345678-1234-1234-1234-123456789abc"
                  />
                  <span class="field-hint">Optional — needed for auto-discovery</span>
                </div>
                
                <div class="form-group">
                  <label>Resource Group</label>
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="editingAoaiEndpoint!.resource_group"
                    placeholder="e.g., my-resource-group"
                  />
                  <span class="field-hint">Optional — needed for auto-discovery</span>
                </div>
              </div>
              }
              
              <div class="form-group">
                <label>Description</label>
                <input 
                  type="text" 
                  class="input" 
                  [(ngModel)]="editingAoaiEndpoint!.description"
                  placeholder="Optional description"
                />
              </div>
              
              <div class="form-group checkbox-group">
                <label>
                  <input 
                    type="checkbox" 
                    [(ngModel)]="editingAoaiEndpoint!.is_active"
                  />
                  Active
                </label>
              </div>
              
              <!-- Model Deployments Section -->
              <div class="form-group deployments-section section-group">
                <label>
                  <span class="material-icons section-icon">memory</span>
                  Model Deployments
                </label>
                <span class="field-hint">
                  @if (isApimType(editingAoaiEndpoint!.endpoint_type)) {
                    APIM endpoints require manual deployment entry. Add the deployment names that your APIM routes to.
                  } @else {
                    Auto-discover with Subscription ID + Resource Group, or add deployments manually below.
                  }
                </span>
                
                @if (!isApimType(editingAoaiEndpoint!.endpoint_type)) {
                <div class="discover-row">
                  <button 
                    class="btn btn-secondary" 
                    (click)="discoverDeployments()"
                    [disabled]="!editingAoaiEndpoint?.endpoint || !editingAoaiEndpoint?.subscription_id || !editingAoaiEndpoint?.resource_group || isDiscoveringDeployments"
                    [title]="!editingAoaiEndpoint?.subscription_id || !editingAoaiEndpoint?.resource_group ? 'Requires Subscription ID and Resource Group' : 'Discover deployments via Azure ARM API (requires identity auth)'"
                  >
                    @if (isDiscoveringDeployments) {
                      <span class="material-icons spinning">sync</span>
                      Discovering...
                    } @else {
                      <span class="material-icons">search</span>
                      Discover Deployments
                    }
                  </button>
                  @if (aoaiDiscoveryError) {
                    <span class="discovery-error">
                      <span class="material-icons">warning</span>
                      {{ aoaiDiscoveryError }}
                    </span>
                  }
                  @if (aoaiDiscoverySuccess) {
                    <span class="discovery-success">
                      <span class="material-icons">check_circle</span>
                      Found {{ editingAoaiEndpoint?.deployments?.length || 0 }} deployments
                    </span>
                  }
                </div>
                }
                
                <div class="deployment-input">
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="newDeploymentName"
                    placeholder="Deployment name (e.g., gpt-4o)"
                    (keyup.enter)="addDeployment()"
                  />
                  <input 
                    type="text" 
                    class="input model-name-input" 
                    [(ngModel)]="newDeploymentModelName"
                    placeholder="Model name (e.g., gpt-4o)"
                  />
                  <button 
                    class="btn btn-secondary btn-sm" 
                    (click)="addDeployment()"
                    [disabled]="!newDeploymentName"
                  >
                    <span class="material-icons">add</span>
                    Add
                  </button>
                </div>
                
                @if (editingAoaiEndpoint!.deployments && editingAoaiEndpoint!.deployments.length > 0) {
                  <div class="deployments-list">
                    @for (deployment of editingAoaiEndpoint!.deployments; track deployment.deployment_name; let i = $index) {
                      <div class="deployment-item">
                        <span class="deployment-name">{{ deployment.deployment_name }}</span>
                        <span class="deployment-model">{{ deployment.model_name || 'Unknown model' }}</span>
                        <button class="btn-chip-remove" (click)="removeDeployment(i)" title="Remove">×</button>
                      </div>
                    }
                  </div>
                } @else {
                  <div class="no-deployments">
                    <span class="material-icons">info</span>
                    No deployments yet. Use Discover (requires identity auth) or add manually above.
                  </div>
                }
              </div>
            </div>
            
            <div class="modal-footer">
              <button class="btn btn-secondary" (click)="closeAoaiEditor()" [disabled]="isSavingAoaiEndpoint">Cancel</button>
              <button 
                class="btn btn-primary" 
                (click)="saveAoaiEndpoint()"
                [disabled]="!isValidAoaiEndpoint() || isSavingAoaiEndpoint"
              >
                @if (isSavingAoaiEndpoint) {
                  <span class="material-icons spinning">sync</span>
                  Saving...
                } @else {
                  {{ editingAoaiEndpoint?.id ? 'Update' : 'Add' }} Endpoint
                }
              </button>
            </div>
          </div>
        </div>
      }
      
      <!-- Agent Editor Modal -->
      @if (showEditor) {
        <div class="modal-overlay" (mousedown)="onOverlayMouseDown($event)" (click)="onAgentOverlayClick($event)">
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
                <label>Model Deployment *</label>
                @if (availableDeployments.length > 0) {
                  <select 
                    class="input"
                    [(ngModel)]="selectedDeploymentKey"
                    (ngModelChange)="onDeploymentSelect($event)"
                    required
                  >
                    <option value="">Select a model deployment...</option>
                    @for (deployment of availableDeployments; track deployment.deployment_name + deployment.endpoint_id) {
                      <option [value]="deployment.endpoint_id + '|' + deployment.deployment_name">
                        {{ deployment.deployment_name }} ({{ deployment.model_name }}) - {{ deployment.endpoint_name }}
                      </option>
                    }
                  </select>
                  <span class="field-hint">Select an Azure OpenAI model deployment. Configure AOAI endpoints below to add more options.</span>
                } @else {
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="editingAgent!.model"
                    placeholder="e.g., gpt-4o, gpt-35-turbo"
                    required
                  />
                  <span class="field-hint">No AOAI endpoints configured. Add endpoints below or enter deployment name manually.</span>
                }
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

            <div class="form-row">
              <div class="form-group">
                <label>Reasoning Effort</label>
                <select
                  class="input"
                  [(ngModel)]="editingAgent!.reasoning_effort"
                >
                  <option value="">Default (medium)</option>
                  <option value="low">Low — faster, cheaper</option>
                  <option value="medium">Medium — balanced</option>
                  <option value="high">High — deeper reasoning</option>
                </select>
                <span class="field-hint">Controls how much the model reasons before answering. Only applies to reasoning models (o-series, gpt-5+) on Responses API endpoints.</span>
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

            <div class="form-group section-group">
              <label>
                <span class="material-icons section-icon">web</span>
                UI Capabilities
              </label>
              <span class="field-hint">Enable chat UI features this agent is allowed to use. These options also inject usage guidance into the runtime prompt for local agents.</span>

              <div class="form-group checkbox-group capability-option">
                <label>
                  <input
                    type="checkbox"
                    [(ngModel)]="editingAgent!.ui_capabilities!.html_preview"
                  />
                  Allow HTML Preview
                </label>
                <span class="field-hint">Lets the agent open the right-side HTML preview panel by returning a complete <code>html_preview</code> fenced block.</span>
              </div>

              <div class="form-group checkbox-group capability-option">
                <label>
                  <input
                    type="checkbox"
                    [(ngModel)]="editingAgent!.ui_capabilities!.structured_input_form"
                  />
                  Allow Structured Input Form
                </label>
                <span class="field-hint">Lets the agent render a structured form by returning a <code>structured_input_form</code> fenced block with JSON field definitions.</span>
              </div>
            </div>
            
            <!-- Orchestrator-specific prompts (visible when is_orchestrator is checked) -->
            @if (editingAgent!.is_orchestrator) {
              <div class="orchestrator-prompts section-group">
                <div class="form-group">
                  <label>Analysis Prompt (Phase 1)</label>
                  <textarea 
                    class="input" 
                    [(ngModel)]="editingAgent!.analysis_prompt"
                    placeholder="Optional. Prompt for analyzing requests and deciding which specialists to call. Use {agent_list} for the list of available specialists. Single-agent orchestrators can leave this blank if they handle requests directly with their own tools."
                    rows="8"
                  ></textarea>
                  <span class="field-hint">Optional for orchestrators. Most useful when this agent delegates to additional specialists. Single-agent orchestrators can leave it blank.</span>
                </div>
                
                <div class="form-group">
                  <label>Synthesis Prompt (Phase 3)</label>
                  <textarea 
                    class="input" 
                    [(ngModel)]="editingAgent!.synthesis_prompt"
                    placeholder="Optional. Prompt for synthesizing specialist responses into a final answer. Use {specialist_responses} for the responses. Single-agent orchestrators can leave this blank if no specialist synthesis is needed."
                    rows="8"
                  ></textarea>
                  <span class="field-hint">Optional for orchestrators. Mainly used when this agent combines responses from additional specialists. Single-agent orchestrators can leave it blank.</span>
                </div>
              </div>
            }
            
            <!-- MCP Server Discovery Section -->
            <div class="form-group section-group">
              <label>
                <span class="material-icons section-icon">hub</span>
                MCP Server Tools
                <span class="material-icons info-tooltip" title="Model Context Protocol (MCP) allows agents to call external tools and APIs. Enter the URL of an MCP server to discover available tools.">info_outline</span>
              </label>
              <span class="field-hint">Connect to MCP servers to give this agent access to external tools and APIs.</span>
              
              <!-- Discovery Input -->
              <div class="mcp-discovery">
                <div class="discovery-input-row">
                  <input 
                    type="text" 
                    class="input" 
                    [(ngModel)]="mcpServerUrl"
                    placeholder="MCP Server URL (e.g., https://mcp-server.example.com/mcp)"
                    title="Enter the HTTP streaming endpoint URL of your MCP server. Examples:\n• https://mcp.example.com/mcp\n• http://localhost:3000/mcp\n• https://api.service.com/mcp"
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
                  @if (getUniqueServerUrls().length > 0) {
                    <div class="mcp-server-urls">
                      @for (url of getUniqueServerUrls(); track url) {
                        <div class="mcp-server-url">
                          <span class="material-icons">link</span>
                          <span>{{ url }}</span>
                        </div>
                      }
                    </div>
                  }
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
            
            <!-- Document Grounding Section -->
            @if (groundingAvailable) {
              <div class="form-group section-group">
                <label>
                  <span class="material-icons section-icon">library_books</span>
                  Document Grounding (RAG)
                  <span class="material-icons info-tooltip" title="Retrieval Augmented Generation (RAG) grounds the agent in your documents. When asked questions, the agent will automatically search indexed documents for relevant context before responding.">info_outline</span>
                </label>
                <span class="field-hint">Ground this agent in documents from Azure Blob Storage or an existing Azure AI Search index. This can be used by specialists and by single-agent orchestrators.</span>
                
                <!-- Grounding Mode Toggle -->
                <div class="grounding-mode-toggle">
                  <label class="toggle-option" [class.active]="groundingMode === 'managed'" (click)="setGroundingMode('managed')">
                    <span class="material-icons" style="font-size: 16px;">cloud_upload</span>
                    Index from Blob Storage
                  </label>
                  <label class="toggle-option" [class.active]="groundingMode === 'external'" (click)="setGroundingMode('external')">
                    <span class="material-icons" style="font-size: 16px;">search</span>
                    Use Existing Index
                  </label>
                </div>
                
                <!-- Managed Mode: Blob Storage Sources -->
                @if (groundingMode === 'managed') {
                  <div class="grounding-input">
                    <div class="grounding-input-row">
                      <input 
                        type="text" 
                        class="input" 
                        [(ngModel)]="groundingSourceName"
                        placeholder="Source name (e.g., HR Policies)"
                        title="A friendly name to identify this document source"
                        style="max-width: 200px;"
                      />
                      <input 
                        type="text" 
                        class="input" 
                        [(ngModel)]="groundingContainerUrl"
                        placeholder="Azure Blob container URL"
                        title="Azure Blob Storage container URL. Format:&#10;https://<storage-account>.blob.core.windows.net/<container>&#10;&#10;Examples:&#10;• https://mycompany.blob.core.windows.net/hr-docs&#10;• https://contoso.blob.core.windows.us/policies&#10;&#10;Supported file types: .txt, .md, .json, .csv, .xml, .html, .py, .js, .ts, .sql, .ps1"
                        style="flex: 1;"
                      />
                      <button 
                        class="btn btn-secondary" 
                        (click)="addGroundingSource()"
                        [disabled]="!groundingContainerUrl || isValidatingGrounding"
                      >
                        <span class="material-icons">{{ isValidatingGrounding ? 'hourglass_empty' : 'add' }}</span>
                        {{ isValidatingGrounding ? 'Validating...' : 'Add Source' }}
                      </button>
                    </div>
                    
                    @if (groundingError) {
                      <div class="discovery-error">
                        <span class="material-icons">error</span>
                        {{ groundingError }}
                      </div>
                    }
                  </div>
                  
                  <!-- Configured Managed Grounding Sources -->
                  @if (getManagedSources().length > 0) {
                    <div class="grounding-sources">
                      <label>Configured Sources ({{ getManagedSources().length }})</label>
                      <div class="sources-list">
                        @for (source of getManagedSources(); track source.container_url; let i = $index) {
                          <div class="source-item">
                            <div class="source-info">
                              <span class="material-icons">folder</span>
                              <div class="source-details">
                                <strong>{{ source.name || 'Documents' }}</strong>
                                <span class="source-url">{{ source.container_url }}</span>
                              </div>
                            </div>
                            <button class="btn-chip-remove" (click)="removeManagedSource(i)" title="Remove source">×</button>
                          </div>
                        }
                      </div>
                      @if (editingAgent!.id) {
                        <div class="reindex-section">
                          <button 
                            class="btn btn-secondary"
                            (click)="reindexGrounding()"
                            [disabled]="isReindexing"
                            title="Re-index documents from blob sources. Use after updating document security markings or blob metadata."
                          >
                            <span class="material-icons" [class.spinning]="isReindexing">{{ isReindexing ? 'sync' : 'refresh' }}</span>
                            {{ isReindexing ? 'Re-indexing...' : 'Re-index Documents' }}
                          </button>
                          @if (reindexResult) {
                            <span class="reindex-result success">
                              <span class="material-icons">check_circle</span>
                              {{ reindexResult }}
                            </span>
                          }
                          @if (reindexError) {
                            <span class="reindex-result error">
                              <span class="material-icons">error</span>
                              {{ reindexError }}
                            </span>
                          }
                        </div>
                      }
                    </div>
                  }
                }
                
                <!-- External Mode: Use Existing Index -->
                @if (groundingMode === 'external') {
                  <div class="grounding-input">
                    <div class="grounding-input-row">
                      <select 
                        class="input"
                        [(ngModel)]="selectedExternalIndex"
                        (ngModelChange)="onExternalIndexSelect($event)"
                        style="flex: 1;"
                      >
                        <option value="">Select an existing search index...</option>
                        @for (idx of availableIndexes; track idx.name) {
                          <option [value]="idx.name">
                            {{ idx.name }} ({{ idx.document_count !== null ? idx.document_count + ' docs' : 'unknown size' }}, {{ idx.field_count }} fields)
                          </option>
                        }
                      </select>
                      <button 
                        class="btn btn-secondary"
                        (click)="loadSearchIndexes()"
                        [disabled]="isLoadingIndexes"
                        title="Refresh the list of available indexes"
                      >
                        <span class="material-icons" [class.spinning]="isLoadingIndexes">{{ isLoadingIndexes ? 'sync' : 'refresh' }}</span>
                      </button>
                    </div>
                    @if (isLoadingIndexes) {
                      <span class="field-hint">Loading indexes from Azure AI Search...</span>
                    }
                    @if (externalIndexError) {
                      <div class="discovery-error">
                        <span class="material-icons">error</span>
                        {{ externalIndexError }}
                      </div>
                    }
                    @if (selectedExternalIndex) {
                      <div class="external-index-info">
                        <span class="material-icons" style="color: #4caf50;">check_circle</span>
                        <span>Using index: <strong>{{ selectedExternalIndex }}</strong></span>
                      </div>
                      <span class="field-hint">
                        The agent will query this index directly. The index must contain 'content' and 'contentVector' fields.
                        See the BYOI documentation for the required schema.
                      </span>
                    }
                  </div>
                }
              </div>
            }
            
            @if (!groundingAvailable) {
              <div class="form-group grounding-unavailable">
                <label>
                  <span class="material-icons" style="vertical-align: middle; font-size: 18px; margin-right: 4px;">library_books</span>
                  Document Grounding (RAG)
                </label>
                <div class="info-message">
                  <span class="material-icons">info</span>
                  <span>Document grounding is not configured. Set AZURE_AI_FOUNDRY_ENDPOINT to enable grounding agents with Azure Blob Storage documents.</span>
                </div>
              </div>
            }
          </div>
          
          <div class="modal-footer">
            <button class="btn btn-secondary" (click)="closeEditor()" [disabled]="isSavingAgent">Cancel</button>
            <button 
              class="btn btn-primary" 
              (click)="saveAgent()"
              [disabled]="!isValidAgent() || isSavingAgent"
            >
              @if (isSavingAgent) {
                <span class="material-icons spinning">sync</span>
                {{ editingAgent?.grounding_sources?.length ? 'Indexing Documents...' : 'Saving...' }}
              } @else {
                {{ editingAgent?.id ? 'Update' : 'Create' }} Agent
              }
            </button>
          </div>
        </div>
      </div>
      }
      
      <!-- A2A Agent Discovery Modal -->
      @if (showA2AModal) {
        <div class="modal-overlay" (mousedown)="onOverlayMouseDown($event)" (click)="onA2AOverlayClick($event)">
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
              
              <div class="form-group">
                <label>
                  Remote App Client ID
                  <span class="label-hint">(optional — only if the agent uses a different Entra ID app registration)</span>
                </label>
                <input 
                  type="text" 
                  class="input" 
                  [(ngModel)]="a2aClientId"
                  placeholder="e.g. 12345678-abcd-1234-efgh-123456789abc"
                />
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
      max-height: 70vh;
      overflow-y: auto;
      padding: 2px;
    }

    .search-filter {
      display: flex;
      align-items: center;
      gap: 6px;
      background-color: var(--input-bg);
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
      max-width: 750px;
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
      
      label:not(.tool-checkbox) {
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

    .section-group {
      border-left: 3px solid var(--accent-color);
      padding-left: var(--spacing-md);
      margin-top: var(--spacing-lg);
      margin-bottom: var(--spacing-lg);
      
      > label:not(.tool-checkbox):first-child {
        color: var(--accent-color);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
    }

    .section-icon {
      font-size: 18px !important;
      color: var(--accent-color);
    }

    .capability-option {
      margin-top: var(--spacing-sm);
      margin-bottom: var(--spacing-sm);
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
    
    .label-hint {
      font-weight: 400;
      font-size: 12px;
      color: var(--text-secondary, #888);
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
      gap: 2px;
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: var(--spacing-xs);
    }
    
    .tool-checkbox {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      text-transform: none;
      
      &:hover {
        background-color: var(--bg-secondary);
      }
      
      input[type="checkbox"] {
        flex: 0 0 16px;
        width: 16px;
        height: 16px;
        margin: 2px 0 0 0;
        cursor: pointer;
      }
      
      .tool-info {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        
        strong {
          font-size: 13px;
          color: var(--text-primary);
          word-break: break-word;
        }
        
        .tool-desc {
          font-size: 11px;
          color: var(--text-muted);
          word-break: break-word;
        }
      }
    }
    
    .selected-tools {
      margin-top: var(--spacing-sm);
      
      label {
        margin-bottom: var(--spacing-xs);
      }
    }

    .mcp-server-urls {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: var(--spacing-sm);
    }

    .mcp-server-url {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1;
      
      .material-icons {
        font-size: 13px;
        line-height: 1;
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
    
    /* Grounding Styles */
    .grounding-mode-toggle {
      display: flex;
      gap: var(--spacing-xs);
      margin: var(--spacing-sm) 0;
    }
    
    .toggle-option {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.15s ease;
      
      &:hover {
        border-color: var(--accent-color);
        color: var(--text-primary);
      }
      
      &.active {
        border-color: var(--accent-color);
        background: color-mix(in srgb, var(--accent-color) 10%, transparent);
        color: var(--accent-color);
        font-weight: 500;
      }
    }
    
    .external-index-info {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: var(--spacing-sm);
      padding: 8px 12px;
      background: color-mix(in srgb, #4caf50 8%, transparent);
      border: 1px solid color-mix(in srgb, #4caf50 30%, transparent);
      border-radius: 6px;
      font-size: 13px;
    }
    
    .grounding-input {
      background-color: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: var(--spacing-md);
      margin-top: var(--spacing-sm);
    }
    
    .grounding-input-row {
      display: flex;
      gap: var(--spacing-sm);
      flex-wrap: wrap;
      
      input, select {
        min-width: 150px;
      }
      
      select {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 13px;
      }
      
      button {
        white-space: nowrap;
      }
    }
    
    .grounding-sources {
      margin-top: var(--spacing-md);
      
      label {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: var(--spacing-xs);
        display: block;
      }
    }
    
    .sources-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }
    
    .source-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm);
      background-color: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      
      .source-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex: 1;
        min-width: 0;
        
        .material-icons {
          color: var(--primary);
          font-size: 20px;
        }
      }
      
      .source-details {
        display: flex;
        flex-direction: column;
        min-width: 0;
        
        strong {
          font-size: 13px;
          color: var(--text-primary);
        }
        
        .source-url {
          font-size: 11px;
          color: var(--text-muted);
          font-family: monospace;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
    }

    .reindex-section {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
      padding-top: var(--spacing-sm);
      border-top: 1px solid var(--border-color);

      .btn {
        flex-shrink: 0;
      }

      .reindex-result {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;

        .material-icons {
          font-size: 16px;
        }

        &.success {
          color: var(--success-color, #4caf50);
        }

        &.error {
          color: var(--error-color, #f44336);
        }
      }
    }
    
    .grounding-unavailable {
      .info-message {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm);
        background-color: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 12px;
        color: var(--text-muted);
        
        .material-icons {
          font-size: 16px;
          color: var(--text-muted);
          flex-shrink: 0;
        }
      }
    }
    
    /* Info tooltip icon in labels */
    .info-tooltip {
      font-size: 16px !important;
      color: var(--text-muted);
      cursor: help;
      vertical-align: middle;
      margin-left: 4px;
      opacity: 0.7;
      
      &:hover {
        opacity: 1;
        color: var(--primary);
      }
    }
    
    /* Spinning animation for loading indicators */
    .spinning {
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    /* Agents Section */
    .agents-section {
      margin-top: var(--spacing-lg);
    }

    /* Azure OpenAI Endpoints Section */
    .aoai-section {
      margin-top: var(--spacing-xl);
      padding-top: var(--spacing-lg);
      border-top: 1px solid var(--border-color);
    }
    
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-md);
      
      h2 {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: 18px;
        font-weight: 600;
        
        .material-icons {
          font-size: 24px;
          color: var(--primary);
        }
      }
      
      .btn-sm {
        padding: 6px 12px;
        font-size: 13px;
      }
    }
    
    .endpoints-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }
    
    .endpoint-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md);
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      
      &:hover {
        border-color: var(--primary);
      }
    }

    .endpoint-type-toggle {
      display: flex;
      gap: 0;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;

      .toggle-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        border: none;
        background: var(--bg-secondary);
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 0.85rem;
        transition: background 0.2s, color 0.2s;

        &:hover:not(.active) {
          background: var(--bg-tertiary, rgba(0,0,0,0.05));
        }

        &.active {
          background: var(--primary);
          color: #fff;
        }

        .material-icons {
          font-size: 18px;
        }
      }
    }
    
    .endpoint-info {
      flex: 1;
      min-width: 0;
    }
    
    .endpoint-name {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: 4px;
      
      strong {
        font-size: 14px;
      }
      
      .badge {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        text-transform: uppercase;
        
        &.inactive {
          background-color: var(--warning);
          color: white;
        }
      }
    }
    
    .endpoint-url {
      font-size: 12px;
      color: var(--text-muted);
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-bottom: 4px;
    }
    
    .endpoint-meta {
      display: flex;
      gap: var(--spacing-md);
      
      .meta-item {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--text-muted);
        
        .material-icons {
          font-size: 14px;
        }
      }
    }
    
    .endpoint-actions {
      display: flex;
      gap: var(--spacing-xs);
    }
    
    .empty-state.small {
      padding: var(--spacing-lg);
      
      .material-icons {
        font-size: 48px;
        margin-bottom: var(--spacing-sm);
      }
      
      p {
        font-size: 13px;
        margin: 0;
      }
    }
    
    .modal-sm {
      max-width: 500px;
    }
    
    /* Deployment management styles */
    .deployments-section {
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }
    
    .deployment-input {
      display: flex;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
      
      .model-name-input {
        max-width: 180px;
      }
      
      .btn-sm {
        padding: 6px 12px;
        white-space: nowrap;
      }
    }
    
    .deployments-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      margin-top: var(--spacing-sm);
    }
    
    .deployment-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 8px 12px;
      background-color: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      
      .deployment-name {
        font-weight: 500;
        font-size: 13px;
      }
      
      .deployment-model {
        font-size: 12px;
        color: var(--text-muted);
        flex: 1;
      }
    }
    
    .no-deployments {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
      margin-top: var(--spacing-sm);
      background-color: var(--bg-tertiary);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-muted);
      
      .material-icons {
        font-size: 16px;
      }
    }
    
    .discover-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-md);
      flex-wrap: wrap;
    }
    
    .discovery-error {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-error);
      font-size: 12px;
      
      .material-icons {
        font-size: 16px;
      }
    }
    
    .discovery-success {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-success);
      font-size: 12px;
      
      .material-icons {
        font-size: 16px;
      }
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .spinning {
      animation: spin 1s linear infinite;
    }
    
    /* UI Settings Section */
    .ui-settings-section {
      margin-top: var(--spacing-lg);
    }
    
    .settings-card {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: var(--spacing-lg);
    }
    
    .settings-group {
      margin-bottom: var(--spacing-lg);
      padding-bottom: var(--spacing-lg);
      border-bottom: 1px solid var(--border-color);
      
      &:last-of-type {
        margin-bottom: var(--spacing-md);
        padding-bottom: 0;
        border-bottom: none;
      }
      
      h3 {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        font-size: 16px;
        font-weight: 600;
        margin-bottom: var(--spacing-xs);
        
        .material-icons {
          font-size: 20px;
          color: var(--primary);
        }
      }
    }
    
    .settings-description {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: var(--spacing-md);
    }
    
    .color-picker-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }
    
    .color-input {
      width: 40px;
      height: 40px;
      border: 2px solid var(--border-color);
      border-radius: 6px;
      cursor: pointer;
      padding: 2px;
      background: none;
    }
    
    .color-text-input {
      max-width: 120px;
      font-family: monospace;
    }
    
    .banner-preview-container {
      margin-top: var(--spacing-md);
      
      label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        margin-bottom: var(--spacing-xs);
      }
    }
    
    .banner-preview {
      width: 100%;
      text-align: center;
      padding: 4px 16px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      border-radius: 4px;
    }
    
    .image-upload-area {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      align-items: flex-start;
    }
    
    .upload-placeholder {
      width: 100%;
      max-width: 400px;
      padding: var(--spacing-lg);
      border: 2px dashed var(--border-color);
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: border-color var(--transition-fast), background-color var(--transition-fast);
      
      &:hover, &.drag-over {
        border-color: var(--primary);
        background-color: var(--bg-hover);
      }
      
      .material-icons {
        font-size: 40px;
        color: var(--text-muted);
        margin-bottom: var(--spacing-sm);
      }
      
      p {
        font-size: 14px;
        color: var(--text-secondary);
        margin-bottom: var(--spacing-xs);
      }
      
      .upload-hint {
        font-size: 12px;
        color: var(--text-muted);
      }
    }
    
    .image-preview {
      position: relative;
      display: inline-block;
      max-width: 300px;
      
      img {
        max-width: 100%;
        max-height: 100px;
        border-radius: 6px;
        border: 1px solid var(--border-color);
      }
      
      .remove-image {
        position: absolute;
        top: -8px;
        right: -8px;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background-color: var(--color-error);
        color: white;
        padding: 0;
        
        .material-icons {
          font-size: 14px;
        }
      }
    }

    .favicon-preview {
      max-width: 80px;
      
      img.favicon-img {
        max-width: 64px;
        max-height: 64px;
        image-rendering: pixelated;
      }
    }
    
    .field-error {
      display: block;
      color: var(--color-error);
      font-size: 12px;
      margin-top: var(--spacing-xs);
    }

    .logo-position-options {
      display: flex;
      gap: var(--spacing-md);
    }

    .radio-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: var(--spacing-md);
      border: 2px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: border-color var(--transition-fast), background-color var(--transition-fast);
      min-width: 120px;
      text-align: center;

      input[type="radio"] {
        display: none;
      }

      .material-icons {
        font-size: 28px;
        color: var(--text-muted);
      }

      .radio-label {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .radio-description {
        font-size: 11px;
        color: var(--text-muted);
      }

      &:hover {
        border-color: var(--primary);
        background-color: var(--bg-hover);
      }

      &.selected {
        border-color: var(--primary);
        background-color: rgba(99, 102, 241, 0.08);

        .material-icons {
          color: var(--primary);
        }
      }
    }

    .settings-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      margin-top: var(--spacing-md);
    }
    
    .save-success {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-success);
      font-size: 13px;
      
      .material-icons {
        font-size: 18px;
      }
    }
    
    .save-error {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-error);
      font-size: 13px;
      
      .material-icons {
        font-size: 18px;
      }
    }
  `]
})
export class AdminComponent implements OnInit, OnDestroy {
  agents: AgentConfig[] = [];
  agentFilter: string = '';

  get filteredAgents(): AgentConfig[] {
    if (!this.agentFilter.trim()) return this.agents;
    const term = this.agentFilter.toLowerCase();
    return this.agents.filter(a =>
      a.name.toLowerCase().includes(term) ||
      (a.description || '').toLowerCase().includes(term)
    );
  }
  isLoading = false;
  showEditor = false;
  editingAgent: AgentConfig | null = null;

  // Track mousedown target to prevent modal close when dragging from inside to outside
  private overlayMousedownTarget: EventTarget | null = null;
  
  // MCP Discovery state
  mcpServerUrl = '';
  isDiscovering = false;
  discoveryError = '';
  discoveredTools: MCPToolConfig[] = [];
  
  // A2A Agent Discovery state
  showA2AModal = false;
  a2aAgentUrl = '';
  a2aClientId = '';  // Remote app registration client ID (for OBO)
  isDiscoveringA2A = false;
  a2aDiscoveryError = '';
  discoveredA2AAgent: A2ADiscoveryResponse | null = null;
  
  // Grounding state
  groundingAvailable = false;
  groundingContainerUrl = '';
  groundingSourceName = '';
  groundingError = '';
  isValidatingGrounding = false;
  isReindexing = false;
  reindexResult = '';
  reindexError = '';
  // External index (BYOI) state
  groundingMode: 'managed' | 'external' = 'managed';
  availableIndexes: SearchIndexInfo[] = [];
  selectedExternalIndex = '';
  isLoadingIndexes = false;
  externalIndexError = '';
  
  // AOAI Endpoints state
  aoaiEndpoints: AOAIEndpointConfig[] = [];
  availableDeployments: AOAIDeploymentOption[] = [];
  showAoaiEditor = false;
  editingAoaiEndpoint: AOAIEndpointConfig | null = null;
  selectedDeploymentKey = '';  // "endpointId|deploymentName"
  newDeploymentName = '';  // For manual deployment entry
  newDeploymentModelName = '';  // For manual deployment entry
  isDiscoveringDeployments = false;
  aoaiDiscoveryError = '';
  aoaiDiscoverySuccess = false;
  isSavingAoaiEndpoint = false;
  
  // Save state
  isSavingAgent = false;
  
  // UI Settings state
  uiSettings: UISettings = {
    classification_banner: {
      enabled: false,
      text: 'UNCLASSIFIED',
      background_color: '#007a33',
      foreground_color: '#ffffff'
    },
    branding_image: null,
    branding_image_filename: null,
    branding_image_position: 'sidebar',
    app_title: null,
    assistant_display_name: null,
    favicon_image: null,
    favicon_image_filename: null
  };
  brandingImagePreview: string | null = null;
  brandingImageError = '';
  isDragging = false;
  faviconImagePreview: string | null = null;
  faviconImageError = '';
  isFaviconDragging = false;
  isSavingSettings = false;
  settingsChanged = false;
  settingsSaveSuccess = false;
  settingsSaveError = '';
  
  private destroy$ = new Subject<void>();
  
  constructor(
    private agentService: AgentService,
    private settingsService: SettingsService
  ) {}
  
  ngOnInit(): void {
    this.loadAgents();
    this.checkGroundingStatus();
    this.loadAoaiEndpoints();
    this.loadUISettings();
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
    this.editingAgent = agent ? { 
      ...agent, 
      mcp_tools: [...(agent.mcp_tools || [])],
      grounding_sources: [...(agent.grounding_sources || [])],
      ui_capabilities: {
        html_preview: !!agent.ui_capabilities?.html_preview,
        structured_input_form: !!agent.ui_capabilities?.structured_input_form,
      }
    } : {
      name: '',
      description: '',
      system_prompt: '',
      model: '',
      aoai_endpoint_id: undefined,
      temperature: 0.7,
      is_orchestrator: false,
      a2a_enabled: true,
      analysis_prompt: '',
      synthesis_prompt: '',
      mcp_tools: [],
      grounding_sources: [],
      ui_capabilities: {
        html_preview: false,
        structured_input_form: false,
      }
    };
    // Reset discovery state when opening editor
    this.mcpServerUrl = '';
    this.discoveredTools = [];
    this.discoveryError = '';
    // Reset grounding input state
    this.groundingContainerUrl = '';
    this.groundingSourceName = '';
    this.groundingError = '';
    this.reindexResult = '';
    this.reindexError = '';
    // Initialize grounding mode based on existing sources
    const existingSources = this.editingAgent?.grounding_sources || [];
    const hasExternal = existingSources.some(s => s.type === 'external');
    this.groundingMode = hasExternal ? 'external' : 'managed';
    this.selectedExternalIndex = hasExternal ? (existingSources.find(s => s.type === 'external')?.index_name || '') : '';
    this.externalIndexError = '';
    if (hasExternal || this.groundingAvailable) {
      this.loadSearchIndexes();
    }
    // Initialize deployment selection
    this.initSelectedDeploymentKey();
    this.showEditor = true;
  }
  
  closeEditor(): void {
    this.showEditor = false;
    this.editingAgent = null;
    this.discoveredTools = [];
    this.mcpServerUrl = '';
    this.discoveryError = '';
    this.selectedDeploymentKey = '';
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
    if (!this.editingAgent || !this.isValidAgent() || this.isSavingAgent) return;
    
    this.isSavingAgent = true;
    
    const operation = this.editingAgent.id
      ? this.agentService.updateAgent(this.editingAgent.id, this.editingAgent)
      : this.agentService.createAgent(this.editingAgent);
    
    operation.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.isSavingAgent = false;
        this.closeEditor();
        this.loadAgents();
      },
      error: (err) => {
        this.isSavingAgent = false;
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

  getUniqueServerUrls(): string[] {
    const tools = this.editingAgent?.mcp_tools;
    if (!tools || tools.length === 0) return [];
    const urls = new Set<string>();
    for (const tool of tools) {
      if (tool.server_url) urls.add(tool.server_url);
    }
    return Array.from(urls);
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
    this.a2aClientId = '';
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
    this.isDiscoveringA2A = false;
  }
  
  closeA2AModal(): void {
    this.showA2AModal = false;
    this.a2aAgentUrl = '';
    this.a2aClientId = '';
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
  }
  
  discoverA2AAgent(): void {
    if (!this.a2aAgentUrl || this.isDiscoveringA2A) return;
    
    this.isDiscoveringA2A = true;
    this.a2aDiscoveryError = '';
    this.discoveredA2AAgent = null;
    
    this.agentService.discoverA2AAgent({ url: this.a2aAgentUrl, a2a_client_id: this.a2aClientId || undefined })
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
    
    this.agentService.addA2AAgent({ url: this.a2aAgentUrl, a2a_client_id: this.a2aClientId || undefined })
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
  
  // =========================================================================
  // Grounding (Document RAG) Methods
  // =========================================================================
  
  checkGroundingStatus(): void {
    this.agentService.getGroundingStatus()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.groundingAvailable = response.available;
        },
        error: (err) => {
          console.error('Failed to check grounding status:', err);
          this.groundingAvailable = false;
        }
      });
  }
  
  addGroundingSource(): void {
    if (!this.groundingContainerUrl || !this.editingAgent) return;
    
    this.isValidatingGrounding = true;
    this.groundingError = '';
    
    // Validate the URL first
    this.agentService.validateGroundingSource(this.groundingContainerUrl)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.isValidatingGrounding = false;
          if (!response.is_available) {
            this.groundingError = response.message;
            return;
          }
          if (!response.valid) {
            this.groundingError = response.message;
            return;
          }
          
          // Add the grounding source
          if (!this.editingAgent!.grounding_sources) {
            this.editingAgent!.grounding_sources = [];
          }
          
          this.editingAgent!.grounding_sources.push({
            container_url: this.groundingContainerUrl,
            name: this.groundingSourceName || this.extractContainerName(this.groundingContainerUrl),
            description: ''
          });
          
          // Reset input fields
          this.groundingContainerUrl = '';
          this.groundingSourceName = '';
        },
        error: (err) => {
          this.isValidatingGrounding = false;
          this.groundingError = err.error?.detail || err.message || 'Failed to validate grounding source';
          console.error('Grounding validation error:', err);
        }
      });
  }
  
  removeGroundingSource(index: number): void {
    if (!this.editingAgent?.grounding_sources) return;
    this.editingAgent.grounding_sources.splice(index, 1);
  }

  removeManagedSource(index: number): void {
    if (!this.editingAgent?.grounding_sources) return;
    const managed = this.getManagedSources();
    if (index < 0 || index >= managed.length) return;
    const source = managed[index];
    const realIndex = this.editingAgent.grounding_sources.indexOf(source);
    if (realIndex !== -1) {
      this.editingAgent.grounding_sources.splice(realIndex, 1);
    }
  }

  getManagedSources(): any[] {
    if (!this.editingAgent?.grounding_sources) return [];
    return this.editingAgent.grounding_sources.filter(
      (s: any) => !s.type || s.type === 'managed'
    );
  }

  setGroundingMode(mode: 'managed' | 'external'): void {
    if (this.groundingMode === mode) return;
    this.groundingMode = mode;
    if (mode === 'external' && this.availableIndexes.length === 0) {
      this.loadSearchIndexes();
    }
  }

  loadSearchIndexes(): void {
    this.isLoadingIndexes = true;
    this.externalIndexError = '';
    this.agentService.listSearchIndexes()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.availableIndexes = response.indexes;
          this.isLoadingIndexes = false;
        },
        error: (err) => {
          this.isLoadingIndexes = false;
          this.externalIndexError = err.error?.detail || err.message || 'Failed to load search indexes';
          console.error('Error loading search indexes:', err);
        }
      });
  }

  onExternalIndexSelect(indexName: string): void {
    this.selectedExternalIndex = indexName;
    if (!this.editingAgent) return;

    // Remove any existing external sources
    this.editingAgent.grounding_sources = (this.editingAgent.grounding_sources || []).filter(
      (s: any) => !s.type || s.type === 'managed'
    );

    if (indexName) {
      // Add the external source
      this.editingAgent.grounding_sources.push({
        type: 'external',
        index_name: indexName,
        name: indexName,
        container_url: ''
      });
    }
  }

  reindexGrounding(): void {
    if (!this.editingAgent?.id || this.isReindexing) return;

    this.isReindexing = true;
    this.reindexResult = '';
    this.reindexError = '';

    this.agentService.reindexGrounding(this.editingAgent.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.isReindexing = false;
          this.reindexResult = response.message;
        },
        error: (err) => {
          this.isReindexing = false;
          this.reindexError = err.error?.detail || err.message || 'Failed to re-index documents';
          console.error('Reindex error:', err);
        }
      });
  }
  
  private extractContainerName(url: string): string {
    // Extract container name from URL like https://account.blob.core.windows.net/container
    try {
      const parts = url.split('/');
      return parts[parts.length - 1] || 'documents';
    } catch {
      return 'documents';
    }
  }
  
  // =========================================================================
  // Azure OpenAI Endpoint Methods
  // =========================================================================
  
  loadAoaiEndpoints(): void {
    this.agentService.loadAoaiEndpoints()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.aoaiEndpoints = response.endpoints;
        },
        error: (err) => {
          console.error('Failed to load AOAI endpoints:', err);
        }
      });
    
    // Also load available deployments
    this.agentService.loadDeployments()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.availableDeployments = response.deployments;
        },
        error: (err) => {
          console.error('Failed to load deployments:', err);
        }
      });
  }
  
  openAoaiEditor(endpoint?: AOAIEndpointConfig): void {
    this.editingAoaiEndpoint = endpoint ? { 
      ...endpoint,
      deployments: [...(endpoint.deployments || [])]
    } : {
      name: '',
      endpoint: '',
      endpoint_type: 'azure_openai',
      api_version: '2024-02-15-preview',
      subscription_id: '',
      resource_group: '',
      is_active: true,
      description: '',
      deployments: []
    };
    // Reset deployment input fields
    this.newDeploymentName = '';
    this.newDeploymentModelName = '';
    // Reset discovery state
    this.isDiscoveringDeployments = false;
    this.aoaiDiscoveryError = '';
    this.aoaiDiscoverySuccess = false;
    this.showAoaiEditor = true;
  }
  
  closeAoaiEditor(): void {
    this.showAoaiEditor = false;
    this.editingAoaiEndpoint = null;
    this.newDeploymentName = '';
    this.newDeploymentModelName = '';
  }

  onOverlayMouseDown(event: MouseEvent): void {
    this.overlayMousedownTarget = event.target;
  }

  onAoaiOverlayClick(event: MouseEvent): void {
    if (this.overlayMousedownTarget === event.currentTarget) {
      this.closeAoaiEditor();
    }
  }

  onAgentOverlayClick(event: MouseEvent): void {
    if (this.overlayMousedownTarget === event.currentTarget) {
      this.closeEditor();
    }
  }

  onA2AOverlayClick(event: MouseEvent): void {
    if (this.overlayMousedownTarget === event.currentTarget) {
      this.closeA2AModal();
    }
  }

  getCloudLabel(endpoint: string, endpointType?: string): string {
    if (endpointType === 'apim' || endpointType === 'apim_responses') return 'APIM';
    const ep = (endpoint || '').toLowerCase();
    if (ep.includes('.azure.us')) return 'Gov';
    if (ep.includes('.azure.cn')) return 'China';
    if (ep.includes('.azure.com')) return 'Commercial';
    return 'Sovereign';
  }

  /** True when the endpoint type is APIM-fronted (chat/completions or Responses). */
  isApimType(endpointType?: string): boolean {
    return endpointType === 'apim' || endpointType === 'apim_responses';
  }

  /** True when the endpoint type targets the Responses API (direct or via APIM). */
  isResponsesType(endpointType?: string): boolean {
    return endpointType === 'azure_openai_responses' || endpointType === 'apim_responses';
  }

  /** Short label for the endpoint type displayed in the editor / list. */
  getEndpointTypeLabel(endpointType?: string): string {
    switch (endpointType) {
      case 'apim': return 'APIM (Chat Completions)';
      case 'azure_openai_responses': return 'Direct AOAI (Responses)';
      case 'apim_responses': return 'APIM (Responses)';
      default: return 'Direct AOAI (Chat Completions)';
    }
  }

  editAoaiEndpoint(endpoint: AOAIEndpointConfig): void {
    this.openAoaiEditor(endpoint);
  }
  
  // Add a deployment to the current endpoint being edited
  addDeployment(): void {
    if (!this.editingAoaiEndpoint || !this.newDeploymentName.trim()) return;
    
    if (!this.editingAoaiEndpoint.deployments) {
      this.editingAoaiEndpoint.deployments = [];
    }
    
    // Check for duplicate
    const exists = this.editingAoaiEndpoint.deployments.some(
      d => d.deployment_name === this.newDeploymentName.trim()
    );
    if (exists) {
      return; // Don't add duplicate
    }
    
    this.editingAoaiEndpoint.deployments.push({
      deployment_name: this.newDeploymentName.trim(),
      model_name: this.newDeploymentModelName.trim() || this.newDeploymentName.trim()
    });
    
    // Reset input fields
    this.newDeploymentName = '';
    this.newDeploymentModelName = '';
  }
  
  // Remove a deployment from the current endpoint being edited
  removeDeployment(index: number): void {
    if (!this.editingAoaiEndpoint?.deployments) return;
    this.editingAoaiEndpoint.deployments.splice(index, 1);
  }
  
  // Discover deployments from the Azure OpenAI endpoint
  discoverDeployments(): void {
    if (!this.editingAoaiEndpoint?.endpoint) return;
    
    this.isDiscoveringDeployments = true;
    this.aoaiDiscoveryError = '';
    this.aoaiDiscoverySuccess = false;
    
    // If endpoint already has an ID, use refresh. Otherwise, we need to save first and then refresh.
    // For new endpoints, we'll create a temporary save to trigger discovery.
    if (this.editingAoaiEndpoint.id) {
      // Existing endpoint - use refresh
      this.agentService.refreshAoaiEndpoint(this.editingAoaiEndpoint.id)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (updated: AOAIEndpointConfig) => {
            this.editingAoaiEndpoint = updated;
            this.isDiscoveringDeployments = false;
            this.aoaiDiscoverySuccess = true;
            setTimeout(() => this.aoaiDiscoverySuccess = false, 3000);
          },
          error: (err: { error?: { detail?: string }; message?: string }) => {
            console.error('Discovery failed:', err);
            this.isDiscoveringDeployments = false;
            this.aoaiDiscoveryError = err.error?.detail || 'Discovery failed. Add deployments manually.';
            setTimeout(() => this.aoaiDiscoveryError = '', 5000);
          }
        });
    } else {
      // New endpoint - save it temporarily to discover, then fetch back
      const tempEndpoint = { ...this.editingAoaiEndpoint };
      this.agentService.createAoaiEndpoint(tempEndpoint)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (saved: AOAIEndpointConfig) => {
            // Endpoint was saved with auto-discovery
            this.editingAoaiEndpoint = saved;
            this.isDiscoveringDeployments = false;
            if (saved.deployments && saved.deployments.length > 0) {
              this.aoaiDiscoverySuccess = true;
              setTimeout(() => this.aoaiDiscoverySuccess = false, 3000);
            } else {
              this.aoaiDiscoveryError = 'No deployments found. Add them manually.';
              setTimeout(() => this.aoaiDiscoveryError = '', 5000);
            }
            this.loadAoaiEndpoints();
          },
          error: (err: { error?: { detail?: string }; message?: string }) => {
            console.error('Discovery failed:', err);
            this.isDiscoveringDeployments = false;
            this.aoaiDiscoveryError = err.error?.detail || 'Discovery failed. Add deployments manually.';
            setTimeout(() => this.aoaiDiscoveryError = '', 5000);
          }
        });
    }
  }

  saveAoaiEndpoint(): void {
    if (!this.editingAoaiEndpoint || !this.isValidAoaiEndpoint() || this.isSavingAoaiEndpoint) return;
    
    this.isSavingAoaiEndpoint = true;
    
    const operation = this.editingAoaiEndpoint.id
      ? this.agentService.updateAoaiEndpoint(this.editingAoaiEndpoint.id, this.editingAoaiEndpoint)
      : this.agentService.createAoaiEndpoint(this.editingAoaiEndpoint);
    
    operation.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.isSavingAoaiEndpoint = false;
        this.closeAoaiEditor();
        this.loadAoaiEndpoints();
      },
      error: (err: { error?: { detail?: string }; message?: string }) => {
        this.isSavingAoaiEndpoint = false;
        console.error('Failed to save AOAI endpoint:', err);
      }
    });
  }
  
  deleteAoaiEndpoint(endpointId: string): void {
    if (confirm('Are you sure you want to delete this Azure OpenAI endpoint?')) {
      this.agentService.deleteAoaiEndpoint(endpointId)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: () => {
            this.loadAoaiEndpoints();
          },
          error: (err) => {
            console.error('Failed to delete AOAI endpoint:', err);
          }
        });
    }
  }
  
  refreshAoaiEndpoint(endpoint: AOAIEndpointConfig): void {
    if (!endpoint.id) return;
    
    this.agentService.refreshAoaiEndpoint(endpoint.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.loadAoaiEndpoints();
        },
        error: (err) => {
          console.error('Failed to refresh AOAI endpoint:', err);
        }
      });
  }
  
  isValidAoaiEndpoint(): boolean {
    return !!(
      this.editingAoaiEndpoint?.name?.trim() &&
      this.editingAoaiEndpoint?.endpoint?.trim()
    );
  }
  
  formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } catch {
      return dateStr;
    }
  }
  
  // Handle deployment selection from dropdown
  onDeploymentSelect(key: string): void {
    if (!key || !this.editingAgent) return;
    
    const [endpointId, deploymentName] = key.split('|');
    this.editingAgent.model = deploymentName;
    this.editingAgent.aoai_endpoint_id = endpointId;
  }
  
  // Initialize selected deployment key when editing an agent
  initSelectedDeploymentKey(): void {
    if (!this.editingAgent) return;
    
    if (this.editingAgent.aoai_endpoint_id && this.editingAgent.model) {
      this.selectedDeploymentKey = `${this.editingAgent.aoai_endpoint_id}|${this.editingAgent.model}`;
    } else if (this.editingAgent.model) {
      // Try to find a matching deployment
      const match = this.availableDeployments.find(d => d.deployment_name === this.editingAgent?.model);
      if (match) {
        this.selectedDeploymentKey = `${match.endpoint_id}|${match.deployment_name}`;
        this.editingAgent.aoai_endpoint_id = match.endpoint_id;
      } else {
        this.selectedDeploymentKey = '';
      }
    } else {
      this.selectedDeploymentKey = '';
    }
  }

  // =========================================================================
  // UI Settings
  // =========================================================================

  loadUISettings(): void {
    this.settingsService.getSettingsAdmin()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (settings) => {
          this.uiSettings = {
            ...settings,
            classification_banner: {
              ...settings.classification_banner
            }
          };
          // Set image preview from existing base64 data
          if (settings.branding_image) {
            this.brandingImagePreview = settings.branding_image;
          }
          // Set favicon preview from existing base64 data
          if (settings.favicon_image) {
            this.faviconImagePreview = settings.favicon_image;
          }
          this.settingsChanged = false;
        },
        error: (err) => {
          console.error('Failed to load UI settings:', err);
        }
      });
  }

  onSettingsChanged(): void {
    this.settingsChanged = true;
    this.settingsSaveSuccess = false;
    this.settingsSaveError = '';
  }

  onBrandingImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.processBrandingFile(input.files[0]);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    this.processBrandingFile(files[0]);
  }

  private processBrandingFile(file: File): void {
    this.brandingImageError = '';

    // Validate file size (500KB max)
    const maxSize = 500 * 1024;
    if (file.size > maxSize) {
      this.brandingImageError = `Image too large (${(file.size / 1024).toFixed(0)}KB). Max is 500KB.`;
      return;
    }

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      this.brandingImageError = 'Invalid file type. Use PNG, JPG, SVG, GIF, or WebP.';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      this.brandingImagePreview = base64;
      this.uiSettings.branding_image = base64;
      this.uiSettings.branding_image_filename = file.name;
      this.onSettingsChanged();
    };
    reader.readAsDataURL(file);
  }

  removeBrandingImage(): void {
    this.brandingImagePreview = null;
    this.uiSettings.branding_image = null;
    this.uiSettings.branding_image_filename = null;
    this.brandingImageError = '';
    this.onSettingsChanged();
  }

  // =========================================================================
  // Favicon Upload
  // =========================================================================

  onFaviconImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.processFaviconFile(input.files[0]);
  }

  onFaviconDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isFaviconDragging = true;
  }

  onFaviconDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isFaviconDragging = false;
  }

  onFaviconDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isFaviconDragging = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    this.processFaviconFile(files[0]);
  }

  private processFaviconFile(file: File): void {
    this.faviconImageError = '';

    // Validate file size (100KB max for favicons)
    const maxSize = 100 * 1024;
    if (file.size > maxSize) {
      this.faviconImageError = `Icon too large (${(file.size / 1024).toFixed(0)}KB). Max is 100KB.`;
      return;
    }

    // Validate file type
    const validTypes = ['image/png', 'image/x-icon', 'image/svg+xml', 'image/vnd.microsoft.icon', 'image/ico'];
    if (!validTypes.includes(file.type)) {
      this.faviconImageError = 'Invalid file type. Use PNG, ICO, or SVG.';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      this.faviconImagePreview = base64;
      this.uiSettings.favicon_image = base64;
      this.uiSettings.favicon_image_filename = file.name;
      this.onSettingsChanged();
    };
    reader.readAsDataURL(file);
  }

  removeFaviconImage(): void {
    this.faviconImagePreview = null;
    this.uiSettings.favicon_image = null;
    this.uiSettings.favicon_image_filename = null;
    this.faviconImageError = '';
    this.onSettingsChanged();
  }

  saveUISettings(): void {
    this.isSavingSettings = true;
    this.settingsSaveSuccess = false;
    this.settingsSaveError = '';

    this.settingsService.updateSettings(this.uiSettings)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (saved) => {
          this.uiSettings = {
            ...saved,
            classification_banner: { ...saved.classification_banner }
          };
          this.isSavingSettings = false;
          this.settingsChanged = false;
          this.settingsSaveSuccess = true;

          // Apply browser title and favicon immediately
          document.title = saved.app_title || 'Agent Chat';
          this.applyFavicon(saved.favicon_image);

          // Auto-hide success after 3s
          setTimeout(() => this.settingsSaveSuccess = false, 3000);
        },
        error: (err) => {
          console.error('Failed to save UI settings:', err);
          this.isSavingSettings = false;
          this.settingsSaveError = err.error?.detail || 'Failed to save settings';
        }
      });
  }

  private applyFavicon(faviconBase64: string | null | undefined): void {
    let link: HTMLLinkElement | null = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = faviconBase64 || 'favicon.ico';
  }
}
