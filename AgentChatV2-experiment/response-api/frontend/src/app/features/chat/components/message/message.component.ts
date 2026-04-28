import { Component, Input, Output, EventEmitter, DoCheck, AfterViewChecked, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';

import { Message } from '../../../../core/services/chat.service';
import { SettingsService } from '../../../../core/services/settings.service';
import { environment } from '@env/environment';
import { WizardFormComponent, ParsedInputField, parseInputFields, stripStructuredInputFormBlock } from '../wizard-form/wizard-form.component';

// Import chatter event type from parent
interface ChatterEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'delegation' | 'content' | 'reasoning';
  agentName: string;
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;      // AG-UI tool_call_id for matching start/args/end/result
  timestamp: number;
  durationMs?: number;      // Duration of tool execution in ms
  tokensInput?: number;     // Input tokens for LLM calls
  tokensOutput?: number;    // Output tokens for LLM calls
  friendlyMessage?: string; // User-friendly description of the action
  renderHint?: 'json' | 'table' | 'text'; // How to render tool result content
}

interface DisplayMessage extends Message {
  isStreaming?: boolean;
  agentResponses?: { agentName: string; content: string }[];
  chatterEvents?: ChatterEvent[];
}

interface TimelineStep {
  id: string;
  type: 'planning' | 'tool' | 'delegation' | 'reasoning';
  label: string;
  status: 'active' | 'done';
  agentName: string;
  durationMs?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  renderHint?: 'json' | 'table' | 'text';
  delegationContent?: string;
  liveNarration?: string;
  narration?: string;
  /** Streaming chain-of-thought / reasoning text from a Responses-API model. */
  reasoningText?: string;
  expanded: boolean;
}

interface AgentTimelineGroup {
  id: string;
  agentName: string;
  role: 'specialist' | 'orchestrator' | 'assistant';
  steps: TimelineStep[];
  hasActiveStep: boolean;
  /** Transient status text (e.g. "Processing information…") rendered
   *  with a shimmer animation below the last step while the agent is
   *  still working. Cleared when a real step is added or stream ends. */
  transientStatus?: string;
}

@Component({
  selector: 'app-message',
  standalone: true,
  imports: [CommonModule, WizardFormComponent],
  template: `
    <div class="message" [class.user]="message.role === 'user'" [class.assistant]="message.role === 'assistant'">
      <div class="message-avatar">
        @if (message.role === 'user') {
          <span class="material-icons">person</span>
        } @else {
          <span class="material-icons">smart_toy</span>
        }
      </div>
      
      <div class="message-content">
        <div class="message-header">
          <span class="message-role">{{ getDisplayRole() }}</span>
          <span class="message-time">{{ formatTime(message.timestamp) }}</span>
        </div>
        
        <!-- Vertical Agent Timeline -->
        @if (hasChatterEvents() || isStreaming) {
          <div class="agent-timeline" [class.streaming]="isStreaming">
            @for (group of agentTimelineGroups; track group.id) {
              <section class="agent-group" [class.agent-group-active]="group.hasActiveStep">
                <div class="agent-group-header">
                  <div class="agent-group-title-wrap">
                    <span class="material-icons agent-group-icon">{{ getAgentGroupIcon(group) }}</span>
                    <div class="agent-group-copy">
                      <div class="agent-group-name">{{ group.agentName }}</div>
                      <div class="agent-group-subtitle">{{ getAgentGroupSubtitle(group) }}</div>
                    </div>
                  </div>
                  <div class="agent-group-meta">
                    <span class="agent-group-role" [class]="'agent-role-' + group.role">{{ group.role }}</span>
                    <span class="agent-group-count">{{ group.steps.length }} step{{ group.steps.length === 1 ? '' : 's' }}</span>
                  </div>
                </div>

                @for (step of group.steps; track step.id; let last = $last) {
                  <div class="tl-step" [class.tl-active]="step.status === 'active'" [class.tl-done]="step.status === 'done'">
                    <!-- Icon column -->
                    <div class="tl-icon-col">
                      <div class="tl-icon" [class]="'tl-icon-' + step.type">
                        @if (step.status === 'active' && isStreaming) {
                          <span class="material-icons spinning">sync</span>
                        } @else {
                          <span class="material-icons">{{ getStepIcon(step) }}</span>
                        }
                      </div>
                      @if (!last || group.hasActiveStep || isStreaming) {
                        <div class="tl-line"></div>
                      }
                    </div>
                    <!-- Content column -->
                    <div class="tl-body">
                      @if (canExpandStep(step)) {
                        <button class="tl-header" (click)="toggleStep(step)">
                          <span class="tl-label">{{ step.label }}</span>
                          <div class="tl-meta">
                            @if (step.durationMs) {
                              <span class="tl-badge tl-badge-duration">{{ formatDuration(step.durationMs) }}</span>
                            }
                            @if (step.toolName) {
                              <span class="tl-badge tl-badge-tool">{{ step.toolName }}</span>
                            }
                          </div>
                          <span class="material-icons tl-chevron">{{ step.expanded ? 'expand_less' : 'expand_more' }}</span>
                        </button>
                      } @else {
                        <div class="tl-header tl-header-static">
                          <span class="tl-label">{{ step.label }}</span>
                          <div class="tl-meta">
                            @if (step.durationMs) {
                              <span class="tl-badge tl-badge-duration">{{ formatDuration(step.durationMs) }}</span>
                            }
                            @if (step.toolName) {
                              <span class="tl-badge tl-badge-tool">{{ step.toolName }}</span>
                            }
                          </div>
                        </div>
                      }
                      @if (isStepExpanded(step) && canExpandStep(step)) {
                        <div class="tl-details">
                          @if (step.type === 'reasoning' && hasReasoningText(step)) {
                            <div class="tl-reasoning-panel" [class.tl-reasoning-streaming]="step.status === 'active'">
                              <div class="tl-reasoning-header">
                                <span class="material-icons tl-reasoning-icon">psychology</span>
                                <span class="tl-reasoning-title">{{ step.status === 'active' ? 'Thinking' : 'Reasoning' }}</span>
                                @if (step.status === 'active') {
                                  <span class="tl-reasoning-pulse"></span>
                                }
                              </div>
                              <div class="tl-reasoning-text">{{ step.reasoningText }}<!--
                                -->@if (step.status === 'active') {<span class="tl-reasoning-cursor">▍</span>}
                              </div>
                            </div>
                          } @else if (hasStepDetailText(step)) {
                            <div class="tl-detail-row">
                              <span class="tl-detail-label">{{ step.status === 'active' ? 'Narration' : 'Summary' }}</span>
                              <p class="tl-summary">{{ getStepDetailText(step) }}</p>
                            </div>
                          }
                          @if (step.toolArgs && hasToolArgs(step.toolArgs)) {
                            <div class="tl-detail-row">
                              <span class="tl-detail-label">Input</span>
                              <pre class="tl-code">{{ formatToolArgs(step.toolArgs) }}</pre>
                            </div>
                          }
                          @if (step.toolResult) {
                            <div class="tl-detail-row">
                              <span class="tl-detail-label">Result</span>
                              @if (step.renderHint === 'json') {
                                <pre class="tl-code">{{ formatJson(step.toolResult) }}</pre>
                              } @else if (step.renderHint === 'table') {
                                <div class="tl-table" [innerHTML]="renderTable(step.toolResult)"></div>
                              } @else {
                                <p class="tl-result-text">{{ truncateContent(step.toolResult, 400) }}</p>
                              }
                            </div>
                          }
                        </div>
                      }
                    </div>
                  </div>
                }
                <!-- Transient shimmer status text (GHCP-style). Replaces in
                     place; never persists as a step. -->
                @if (group.transientStatus) {
                  <div class="tl-shimmer-status" aria-live="polite">
                    <span class="tl-shimmer-text">{{ group.transientStatus }}</span>
                  </div>
                }
              </section>
            }
            <!-- Live working indicator when no steps exist yet (very first moment).
                 We intentionally do NOT render this between completed groups
                 because that creates a "deadzone" placeholder while we wait for
                 the next agent's first event to arrive. -->
            @if (isStreaming && timelineSteps.length === 0) {
              <div class="tl-step tl-active tl-step-working-alone">
                <div class="tl-icon-col">
                  <div class="tl-icon tl-icon-working">
                    <span class="material-icons spinning">sync</span>
                  </div>
                </div>
                <div class="tl-body">
                  <span class="tl-label tl-label-muted">{{ getIdleWorkingLabel() }}</span>
                </div>
              </div>
            }
          </div>
        }
        
        @if (hasImageAttachment()) {
          <div class="image-attachment">
            <img [src]="getImageDataUrl()" [alt]="getImageFilename()" class="chat-image" />
            <span class="image-label">
              <span class="material-icons">image</span>
              {{ getImageFilename() }}
            </span>
          </div>
        } @else {
          <div class="message-text" [innerHTML]="formatContent(message.content)"></div>
        }
        
        @if (getParsedFields().length > 0 && !isStreaming && !formSubmitted) {
          <app-wizard-form
            [fields]="getParsedFields()"
            [disabled]="isStreaming"
            (formSubmit)="onWizardSubmit($event)"
          ></app-wizard-form>
        }

        @if (isStreaming) {
          <span class="typing-indicator">
            <span></span><span></span><span></span>
          </span>
        }
      </div>
    </div>
  `,
  styles: [`
    .message {
      display: flex;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      border-radius: 8px;
      animation: slideIn var(--transition-normal);
      
      &.user {
        background-color: var(--bg-secondary);
        
        .message-avatar {
          background-color: var(--primary);
        }
      }
      
      &.assistant {
        background-color: var(--bg-tertiary);
        
        .message-avatar {
          background-color: #10a37f;
        }
      }
    }
    
    .message-avatar {
      width: 36px;
      height: 36px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      
      .material-icons {
        font-size: 20px;
        color: white;
      }
    }
    
    .message-content {
      flex: 1;
      min-width: 0;
    }
    
    .message-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
    }
    
    .message-role {
      font-weight: 600;
      font-size: 14px;
    }
    
    .message-time {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    /* ─── Agent Timeline ─────────────────────────────────── */
    .agent-timeline {
      margin: var(--spacing-sm) 0;
      padding: var(--spacing-sm) var(--spacing-md) var(--spacing-xs);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: var(--bg-primary);
      display: flex;
      flex-direction: column;
      gap: 12px;

      &.streaming {
        border-color: var(--primary);
        box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.15);
      }
    }

    .agent-group {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: var(--bg-secondary);
      padding: 10px 10px 4px;

      &.agent-group-active {
        border-color: rgba(59, 130, 246, 0.45);
        box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.12);
      }
    }

    .agent-group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-color);
    }

    .agent-group-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .agent-group-icon {
      font-size: 18px;
      color: var(--primary);
    }

    .agent-group-copy {
      min-width: 0;
    }

    .agent-group-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .agent-group-subtitle {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.2;
      margin-top: 2px;
    }

    .agent-group-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .agent-group-role,
    .agent-group-count {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 999px;
    }

    .agent-group-count {
      background-color: var(--bg-tertiary);
      color: var(--text-muted);
    }

    .agent-role-specialist {
      background-color: rgba(59, 130, 246, 0.12);
      color: #3b82f6;
    }

    .agent-role-orchestrator {
      background-color: rgba(139, 92, 246, 0.12);
      color: #8b5cf6;
    }

    .agent-role-assistant {
      background-color: rgba(16, 185, 129, 0.12);
      color: #10b981;
    }

    .tl-step {
      display: flex;
      gap: 10px;
      min-height: 28px;
    }

    .tl-step-working-alone {
      padding: 2px 0 0;
    }

    .tl-icon-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-shrink: 0;
      width: 22px;
    }

    .tl-icon {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;

      .material-icons {
        font-size: 17px;
      }

      &.tl-icon-planning .material-icons { color: #f59e0b; }
      &.tl-icon-tool .material-icons     { color: #3b82f6; }
      &.tl-icon-delegation .material-icons { color: #8b5cf6; }
      &.tl-icon-reasoning .material-icons  { color: #06b6d4; }
      &.tl-icon-working .material-icons    { color: var(--primary); }
    }

    .tl-line {
      flex: 1;
      width: 1px;
      background-color: var(--border-color);
      min-height: 6px;
      margin: 2px 0 0;
    }

    .tl-body {
      flex: 1;
      min-width: 0;
      padding-bottom: 6px;
    }

    .tl-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      text-align: left;
      border-radius: 4px;
      transition: background-color var(--transition-fast);

      &:hover {
        background-color: var(--bg-hover);
      }
    }

    .tl-header-static {
      cursor: default;

      &:hover {
        background-color: transparent;
      }
    }

    .tl-label {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tl-label-muted {
      color: var(--text-muted);
      font-style: italic;
    }

    .tl-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .tl-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
      white-space: nowrap;

      &.tl-badge-agent {
        background-color: rgba(139, 92, 246, 0.12);
        color: #8b5cf6;
      }

      &.tl-badge-duration {
        background-color: rgba(16, 185, 129, 0.12);
        color: #10b981;
      }

      &.tl-badge-tool {
        background-color: rgba(59, 130, 246, 0.1);
        color: #3b82f6;
        font-family: 'Consolas', 'Monaco', monospace;
      }
    }

    .tl-chevron {
      font-size: 16px !important;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    /* Step detail panel (expanded) */
    .tl-details {
      margin: 4px 0 var(--spacing-xs) 4px;
      padding-left: var(--spacing-sm);
      border-left: 2px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tl-detail-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .tl-detail-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }

    .tl-code {
      font-size: 11px;
      background-color: var(--bg-secondary);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: 4px;
      overflow-x: auto;
      max-height: 120px;
      margin: 0;
      font-family: 'Consolas', 'Monaco', monospace;
      white-space: pre;
    }

    .tl-result-text {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 0;
      max-height: 120px;
      overflow: auto;
    }

    .tl-summary {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 0;
      white-space: pre-wrap;
      max-height: 140px;
      overflow: auto;
    }

    .tl-table {
      overflow-x: auto;
      font-size: 11px;

      :deep(.tool-table) {
        width: 100%;
        border-collapse: collapse;
      }

      :deep(th), :deep(td) {
        padding: 3px 8px;
        border: 1px solid var(--border-color);
      }

      :deep(th) {
        background-color: var(--bg-secondary);
        font-weight: 600;
      }
    }

    .tl-step.tl-done .tl-icon-planning .material-icons { color: #10b981; }
    .tl-step.tl-done .tl-icon-tool .material-icons     { color: #10b981; }
    .tl-step.tl-done .tl-icon-delegation .material-icons { color: #10b981; }
    .tl-step.tl-done .tl-icon-reasoning .material-icons  { color: #10b981; }

    /* ─── Reasoning panel (Responses-API chain-of-thought) ───── */
    .tl-reasoning-panel {
      margin-top: 6px;
      padding: 10px 12px;
      border-radius: 8px;
      background: linear-gradient(180deg,
        rgba(6, 182, 212, 0.08) 0%,
        rgba(6, 182, 212, 0.03) 100%);
      border: 1px solid rgba(6, 182, 212, 0.25);
      border-left: 3px solid #06b6d4;
    }

    .tl-reasoning-panel.tl-reasoning-streaming {
      background: linear-gradient(180deg,
        rgba(6, 182, 212, 0.14) 0%,
        rgba(6, 182, 212, 0.05) 100%);
      box-shadow: 0 0 0 1px rgba(6, 182, 212, 0.15) inset;
    }

    .tl-reasoning-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }

    .tl-reasoning-icon {
      font-size: 16px;
      color: #06b6d4;
    }

    .tl-reasoning-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #06b6d4;
    }

    .tl-reasoning-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #06b6d4;
      animation: reasoningPulse 1.4s ease-in-out infinite;
    }

    @keyframes reasoningPulse {
      0%, 100% { opacity: 0.3; transform: scale(0.85); }
      50%      { opacity: 1;   transform: scale(1.15); }
    }

    .tl-reasoning-text {
      font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-secondary, #4b5563);
      max-height: 220px;
      overflow-y: auto;
      scroll-behavior: smooth;
      font-style: italic;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow-y: auto;
    }

    .tl-reasoning-cursor {
      display: inline-block;
      margin-left: 1px;
      color: #06b6d4;
      animation: reasoningBlink 1s steps(2, start) infinite;
      font-style: normal;
    }

    @keyframes reasoningBlink {
      to { visibility: hidden; }
    }

    /* GHCP-style transient shimmer status: a single line of action text
       that replaces itself in place. Wave of brightness travels across
       the text. Not a step; not persisted. */
    .tl-shimmer-status {
      padding: 6px 14px 8px 44px; /* align text under the icon column */
      font-size: 0.82rem;
      line-height: 1.3;
      min-height: 18px;
    }
    .tl-shimmer-text {
      display: inline-block;
      background: linear-gradient(
        90deg,
        rgba(160, 175, 195, 0.55) 0%,
        rgba(160, 175, 195, 0.55) 35%,
        #f1f5f9 50%,
        rgba(160, 175, 195, 0.55) 65%,
        rgba(160, 175, 195, 0.55) 100%
      );
      background-size: 200% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
      animation: tlShimmer 2.2s linear infinite;
      font-style: italic;
      letter-spacing: 0.01em;
    }
    @keyframes tlShimmer {
      0%   { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    .image-attachment {
      margin: var(--spacing-sm) 0;

      .chat-image {
        max-width: 400px;
        max-height: 400px;
        border-radius: 8px;
        border: 1px solid var(--border-color);
        cursor: pointer;
        transition: transform 0.2s;
        display: block;

        &:hover {
          transform: scale(1.02);
        }
      }

      .image-label {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
        font-size: 12px;
        color: var(--text-muted);

        .material-icons {
          font-size: 14px;
        }
      }
    }

    /* MCP Document Download Card */
    :deep(.mcp-download-card) {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      margin: 6px 0;
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      max-width: 400px;
      transition: border-color var(--transition-fast);

      &:hover {
        border-color: var(--primary);
      }

      .mcp-download-icon {
        font-size: 28px;
        color: var(--primary);
        flex-shrink: 0;
      }

      .mcp-download-name {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mcp-download-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        color: #fff !important;
        background-color: var(--primary);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        text-decoration: none !important;
        white-space: nowrap;
        transition: background-color var(--transition-fast);

        .material-icons {
          font-size: 16px;
        }

        &:hover {
          background-color: var(--primary-hover, #2563eb);
        }
      }
    }

    .message-text {
      font-size: 14px;
      line-height: 1.7;
      word-break: break-word;

      /* Paragraphs */
      :deep(p) {
        margin: 0 0 0.6em 0;
        &:last-child { margin-bottom: 0; }
      }

      /* Headings — kept compact for chat context */
      :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) {
        line-height: 1.35;
        color: var(--text-primary);
        &:first-child { margin-top: 0; }
      }
      :deep(h1) {
        font-size: 1.15em;
        font-weight: 700;
        margin: 1.1em 0 0.5em 0;
        padding-bottom: 0.3em;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(h2) {
        font-size: 1.05em;
        font-weight: 700;
        margin: 1em 0 0.4em 0;
        padding-bottom: 0.25em;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(h3) {
        font-size: 0.95em;
        font-weight: 600;
        margin: 0.85em 0 0.3em 0;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-secondary);
      }
      :deep(h4), :deep(h5), :deep(h6) {
        font-size: 0.9em;
        font-weight: 600;
        margin: 0.75em 0 0.25em 0;
        color: var(--text-secondary);
      }

      /* Links */
      :deep(a) {
        color: var(--md-link) !important;
        text-decoration: none;
        border-bottom: 1px solid var(--md-link-border);
        transition: border-color 0.2s ease, color 0.2s ease;
        
        &:visited {
          color: var(--md-link-visited) !important;
        }
        
        &:hover {
          color: var(--md-link-hover) !important;
          border-bottom-color: var(--md-link);
        }
        
        &::after {
          content: '↗';
          font-size: 0.7em;
          margin-left: 2px;
          opacity: 0.5;
          vertical-align: super;
        }
        
        &.doc-citation {
          color: #90caf9 !important;
          border-bottom-style: dotted;
          
          &:visited {
            color: #90caf9 !important;
          }
          
          &::before {
            content: '📄 ';
            font-size: 0.85em;
          }
        }
      }

      /* Inline code */
      :deep(code) {
        background-color: var(--md-code-bg);
        border: 1px solid var(--md-code-border);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 0.9em;
        color: var(--md-code-color);
      }

      /* Code blocks */
      :deep(pre) {
        background-color: var(--md-pre-bg);
        border: 1px solid var(--border-color);
        padding: var(--spacing-md);
        border-radius: 8px;
        overflow-x: auto;
        margin: 0.75em 0;
        
        code {
          background: none;
          border: none;
          padding: 0;
          font-size: 13px;
          line-height: 1.5;
          color: var(--text-secondary);
        }
      }

      /* Lists — main spacing handled in global styles.scss to override * reset */
      :deep(li) {
        &::marker {
          color: var(--text-muted);
        }
      }
      /* Tighter lists: remove paragraph margins inside li */
      :deep(li > p) {
        margin: 0;
      }

      /* Blockquotes */
      :deep(blockquote) {
        margin: 0.6em 0;
        padding: 0.4em 0.8em;
        border-left: 3px solid var(--primary);
        background-color: var(--md-blockquote-bg);
        border-radius: 0 6px 6px 0;
        color: var(--text-secondary);
        font-style: italic;
        
        p {
          margin: 0.2em 0;
        }
      }

      /* Tables */
      :deep(table) {
        width: max-content;
        max-width: 100%;
        border-collapse: collapse;
        margin: 0.75em 0;
        font-size: 13px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        overflow: hidden;
        display: table;
      }
      :deep(thead) {
        background-color: var(--md-table-head-bg);
      }
      :deep(th) {
        padding: 8px 14px;
        text-align: left;
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-color);
      }
      :deep(td) {
        padding: 6px 14px;
        border-bottom: 1px solid var(--border-color);
      }
      :deep(tbody tr):last-child td {
        border-bottom: none;
      }
      :deep(tbody tr):hover {
        background-color: var(--md-table-stripe);
      }

      /* Horizontal rule — subtle separator in chat */
      :deep(hr) {
        border: none;
        height: 1px;
        background: linear-gradient(
          to right,
          transparent,
          var(--border-color) 20%,
          var(--border-color) 80%,
          transparent
        );
        margin: 0.8em 0;
      }

      /* Strong / emphasis */
      :deep(strong) {
        font-weight: 600;
        color: var(--text-primary);
      }
      :deep(em) {
        font-style: italic;
        color: var(--text-secondary);
      }

      /* Images */
      :deep(img) {
        max-width: 100%;
        border-radius: 8px;
        border: 1px solid var(--border-color);
      }
    }
    
    .typing-indicator {
      display: inline-flex;
      gap: 4px;
      padding: var(--spacing-xs) 0;
      
      span {
        width: 8px;
        height: 8px;
        background-color: var(--text-muted);
        border-radius: 50%;
        animation: bounce 1.4s infinite ease-in-out both;
        
        &:nth-child(1) { animation-delay: -0.32s; }
        &:nth-child(2) { animation-delay: -0.16s; }
      }
    }
    
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `]
})
export class MessageComponent implements DoCheck, OnInit, OnDestroy {
  @Input() message!: DisplayMessage;
  @Input() isStreaming = false;
  /** IDs of selected agents that have document grounding — used for auto-linking filenames */
  @Input() groundedAgentIds: string[] = [];
  /** Agent IDs explicitly allowed to trigger the structured input form renderer. */
  @Input() structuredFormAgentIds: string[] = [];
  /** Whether this is the last assistant message (only show wizard on the last one) */
  @Input() isLastAssistantMessage = false;
  @Output() formSubmit = new EventEmitter<string>();

  formSubmitted = false;
  private cachedParsedFields: ParsedInputField[] | null = null;
  private cachedContent: string | null = null;

  // Timeline state
  timelineSteps: TimelineStep[] = [];
  agentTimelineGroups: AgentTimelineGroup[] = [];
  private toolCallStepIndex = new Map<string, number>();
  /** Latest transient status text per agent (e.g. "Processing information…").
   *  Rendered as a shimmer line, replaced in place — never persisted. */
  private transientStatusByAgent = new Map<string, string>();
  private readonly recentCompletionOpenMs = 4000;
  private transientExpandedSteps = new Map<string, number>();
  private transientCollapseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  
  private previousTimelineSignature = '';
  private md!: ReturnType<typeof marked.use>;
  
  constructor(
    private http: HttpClient,
    private settingsService: SettingsService
  ) {}

  getDisplayRole(): string {
    if (this.message.role === 'user') return 'You';
    const configured = this.settingsService.currentSettings.assistant_display_name?.trim();
    return configured || 'Assistant';
  }

  ngOnInit(): void {
    // Configure marked with sensible defaults
    this.md = marked.use({
      breaks: true,
      gfm: true,
    });
    // Build timeline for already-loaded messages (history)
    if (this.hasChatterEvents()) {
      this.rebuildTimeline();
      this.previousTimelineSignature = this.buildTimelineSignature();
    }
  }

  ngOnDestroy(): void {
    for (const timer of this.transientCollapseTimers.values()) {
      clearTimeout(timer);
    }
    this.transientCollapseTimers.clear();
    this.transientExpandedSteps.clear();
  }
  
  /**
   * Intercept clicks on .doc-citation links.
   * Instead of navigating (which loses the Authorization header),
   * fetch the document via HttpClient and open a blob URL in a new tab.
   */
  @HostListener('click', ['$event'])
  onDocCitationClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    // Handle MCP download button clicks — download to desktop
    const downloadAnchor = target.closest('a.mcp-download-btn') as HTMLAnchorElement | null;
    if (downloadAnchor) {
      event.preventDefault();
      event.stopPropagation();
      const url = downloadAnchor.getAttribute('href');
      if (!url) return;

      // Extract filename from the sibling element
      const card = downloadAnchor.closest('.mcp-download-card');
      const nameEl = card?.querySelector('.mcp-download-name');
      const fileName = nameEl?.textContent?.trim() || 'document';

      // For URLs that go through our API, use HttpClient (auth interceptor adds token).
      // For external URLs (MCP servers, pre-signed), fetch directly.
      const isInternal = url.startsWith(environment.apiUrl) || url.startsWith('/api');

      if (isInternal) {
        this.http.get(url, { responseType: 'blob', observe: 'response' }).subscribe({
          next: (response) => this.triggerDownload(response.body, fileName, response.headers.get('Content-Type')),
          error: (err) => {
            console.error('Failed to download document:', err);
            alert(err.status === 404 ? 'Document not found.' : 'Failed to download document. Please try again.');
          }
        });
      } else {
        // External URL — open directly and let the browser/MCP server handle it
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      return;
    }

    // Handle grounding document citation clicks — open in new tab
    const anchor = target.closest('a.doc-citation') as HTMLAnchorElement | null;
    if (!anchor) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const url = anchor.getAttribute('href');
    if (!url) return;
    
    // Fetch with auth header (Angular's HttpInterceptor adds Bearer token)
    this.http.get(url, { responseType: 'blob', observe: 'response' }).subscribe({
      next: (response) => {
        const blob = response.body;
        if (!blob) return;
        const contentType = response.headers.get('Content-Type') || 'text/plain';
        const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
        window.open(blobUrl, '_blank');
        // Revoke after a delay to allow the tab to load
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      },
      error: (err) => {
        console.error('Failed to fetch grounding document:', err);
        if (err.status === 403) {
          alert('You do not have permission to view this document.');
        } else if (err.status === 404) {
          alert('Document not found.');
        } else {
          alert('Failed to load document. Please try again.');
        }
      }
    });
  }
  
  ngDoCheck(): void {
    const signature = this.buildTimelineSignature();
    if (signature !== this.previousTimelineSignature) {
      this.rebuildTimeline();
      this.previousTimelineSignature = signature;
    }
  }
  
  ngAfterViewChecked(): void {
    // No-op: inner container scroll removed; outer message list handles scrolling
  }
  
  formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  formatContent(content: string): string {
    // Strip explicit structured_input_form blocks from rendered prose; valid
    // form blocks are shown as UI below the message instead.
    let cleaned = stripStructuredInputFormBlock(content);

    // Strip Kramdown/Jekyll-style attribute syntax that marked doesn't support,
    // e.g. {:target="_blank"} or {:.class-name}
    cleaned = cleaned.replace(/\{:\s*[^}]+\}/g, '');

    // Use marked for full markdown rendering
    let result = (this.md ? this.md.parse(cleaned) : marked.parse(cleaned)) as string;
    
    // Open all links in new tabs
    result = result.replace(/<a\s+href="/g, '<a target="_blank" rel="noopener noreferrer" href="');
    
    // Detect external document download URLs in assistant messages and render
    // download cards.  MCP tools that create documents return direct URLs;
    // we render them as download cards so the user can save files to their desktop.
    //
    // IMPORTANT: Three distinct URL categories are handled separately:
    //  1. Azure Blob Storage URLs → rewritten to blob-proxy with doc-citation
    //     class so the click handler fetches via HttpClient with auth + SS token
    //     access-checker checks.  These are citations from MCP tools that
    //     reference existing access-controlled documents.
    //  2. External non-blob URLs → rendered as download cards for direct
    //     download.  These are new documents created by MCP tools (e.g. a
    //     generated policy document served by the MCP server itself).
    //  3. Internal API / relative filenames → left untouched for the
    //     grounding auto-linker below.
    if (this.message.role === 'assistant') {

      // ── Category 1: Azure Blob Storage URLs → blob-proxy with SS token checks ──
      const blobUrlPattern = /(<a\s[^>]*href=")(https:\/\/[^"]+\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\/[^"]+)("[^>]*>)/gi;
      result = result.replace(blobUrlPattern, (_m, prefix, blobUrl, suffix) => {
        const proxyUrl = `${environment.apiUrl}/documents/blob-proxy?url=${encodeURIComponent(blobUrl)}`;
        const classedSuffix = suffix.includes('class="')
          ? suffix.replace('class="', 'class="doc-citation ')
          : suffix.replace('>', ' class="doc-citation">');
        return `${prefix}${proxyUrl}${classedSuffix}`;
      });

      // Also catch bare blob URLs in text (not inside <a> tags) and wrap them
      const bareBlobPattern = /(?<!href="|">)(https:\/\/[^\s<"]+\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\/([^\s<"]+))/gi;
      result = result.replace(bareBlobPattern, (_m, blobUrl, blobPath) => {
        const proxyUrl = `${environment.apiUrl}/documents/blob-proxy?url=${encodeURIComponent(blobUrl)}`;
        const fileName = decodeURIComponent(blobPath.split('/').pop() || 'document');
        return `<a href="${proxyUrl}" target="_blank" rel="noopener noreferrer" class="doc-citation">${fileName}</a>`;
      });

      // ── Category 2: External non-blob URLs → download cards ──
      const docExtensions = 'pdf|docx?|xlsx?|pptx?|csv|txt|md|zip|json|xml|html';

      // Helper: returns true for URLs that should NOT become download cards
      const isNonDownloadUrl = (url: string): boolean => {
        // Internal API routes (grounding proxy, blob-proxy, etc.)
        if (url.startsWith(environment.apiUrl) || url.startsWith('/api')) return true;
        // Relative filenames (no scheme) — handled by grounding auto-linker
        if (!url.includes('://')) return true;
        // Azure Blob Storage URLs — already rewritten to blob-proxy above
        if (/\.blob\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)/i.test(url)) return true;
        return false;
      };

      // Rewrite <a> tags whose href ends in a document extension
      const docLinkPattern = new RegExp(
        `(<a\\s[^>]*href=")(([^"]+\\.(${docExtensions})(?:\\?[^"]*)?))("[^>]*>)([\\s\\S]*?)(</a>)`, 'gi'
      );
      result = result.replace(docLinkPattern, (match, _prefix, fullUrl, _path, _ext, _suffix, _linkText, _closeTag) => {
        if (isNonDownloadUrl(fullUrl)) return match;
        const fileName = this.extractFileName(fullUrl);
        return this.buildDownloadCard(fullUrl, fileName);
      });

      // Convert bare external document URLs in text (not inside <a> tags)
      const bareDocUrlPattern = new RegExp(
        `(?<!href="|">)(https?://[^\\s<"]+\\.(${docExtensions})(?:\\?[^\\s<"]*)?)`, 'gi'
      );
      result = result.replace(bareDocUrlPattern, (match, fullUrl) => {
        if (isNonDownloadUrl(fullUrl)) return match;
        const fileName = this.extractFileName(fullUrl);
        return this.buildDownloadCard(fullUrl, fileName);
      });
    }
    
    // Auto-link grounding document file names (e.g., meeting-snack-policy.md)
    // Only for assistant messages from agents that have document grounding configured.
    // This prevents interference with non-grounded agents (e.g., MCP-only agents
    // whose tool results may contain filenames that should NOT become grounding links).
    if (this.message.role === 'assistant' && this.groundedAgentIds.length > 0) {
      const agentId = this.groundedAgentIds[0];
      const docExtensions = 'md|txt|json|csv|pdf';
      const fileNameRe = `[\\w][\\w.-]*\\.(?:${docExtensions})`;
      
      // Step 1: Rewrite any existing <a href="...filename.ext"> links created by the
      // markdown converter (LLM wrote [file.md](file.md) or [file.md](sandbox:/file.md))
      // — redirect them to the grounding proxy.  Strip any scheme/path prefix before the filename.
      const existingLinkPattern = new RegExp(
        `(<a\\s[^>]*href=")(?:[^"]*/)?(${fileNameRe})("[^>]*>)`, 'gi'
      );
      result = result.replace(existingLinkPattern, (_m, prefix, fileName, suffix) => {
        const url = `${environment.apiUrl}/documents/grounding/${agentId}/${encodeURIComponent(fileName)}`;
        // Ensure the doc-citation class is added
        const classAttr = suffix.includes('class="') 
          ? suffix.replace('class="', 'class="doc-citation ') 
          : suffix.replace('>', ' class="doc-citation">');
        return `${prefix}${url}${classAttr}`;
      });
      
      // Step 2: Auto-link bare filenames in text segments that are NOT inside <a>...</a> tags.
      const fileNamePattern = new RegExp(`\\b(${fileNameRe})\\b`, 'g');
      // Track whether we're inside an <a> tag to avoid nesting anchors.
      let insideAnchor = false;
      result = result.replace(
        /(<a\b[^>]*>)|(<\/a>)|(<[^>]+>)|([^<]+)/gi,
        (_wholeMatch, openA, closeA, otherTag, text) => {
          if (openA) { insideAnchor = true; return openA; }
          if (closeA) { insideAnchor = false; return closeA; }
          if (otherTag) return otherTag;
          // Only auto-link in text that's NOT inside an existing <a> tag
          if (insideAnchor || !text) return text || '';
          return text.replace(fileNamePattern, (_fm: string, fileName: string) => {
            const url = `${environment.apiUrl}/documents/grounding/${agentId}/${encodeURIComponent(fileName)}`;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="doc-citation">${fileName}</a>`;
          });
        }
      );
    }
    
    return result;
  }
  
  /**
   * Check if this message has an image attachment in metadata.
   */
  hasImageAttachment(): boolean {
    const metadata = (this.message as any).metadata;
    return !!metadata?.['image_attachment'];
  }

  /**
   * Build a data URL from the base64 image attachment.
   */
  getImageDataUrl(): string {
    const metadata = (this.message as any).metadata;
    const img = metadata?.['image_attachment'] as Record<string, unknown> | undefined;
    if (!img) return '';
    return `data:${img['content_type']};base64,${img['base64']}`;
  }

  /**
   * Get the original filename from the image attachment.
   */
  getImageFilename(): string {
    const metadata = (this.message as any).metadata;
    const img = metadata?.['image_attachment'] as Record<string, unknown> | undefined;
    return (img?.['filename'] as string) || 'Image';
  }

  /* ─── Timeline methods ─────────────────────────────────── */

  /** Build the full timeline from scratch (used for history messages on init). */
  private rebuildTimeline(): void {
    const expandedStepIds = new Set(
      this.timelineSteps
        .filter(step => step.status === 'done' && step.expanded)
        .map(step => step.id)
    );

    this.timelineSteps = [];
    this.agentTimelineGroups = [];
    this.toolCallStepIndex.clear();
    this.transientStatusByAgent.clear();
    const events = this.getChatterEvents();
    events.forEach(e => this.processTimelineEvent(e));
    if (!this.isStreaming) {
      this.finalizeActiveStep();
    }

    for (const step of this.timelineSteps) {
      if (step.status === 'done' && expandedStepIds.has(step.id)) {
        step.expanded = true;
      }
    }

    this.agentTimelineGroups = this.buildAgentTimelineGroups();
  }

  /** Process a single incoming event and update timelineSteps in place. */
  private processTimelineEvent(event: ChatterEvent): void {
    if (event.type === 'thinking') {
      this.upsertPlanningStep(event);
      return;
    }

    // Any non-heartbeat / non-tool event for this agent supersedes the
    // transient shimmer status. Tool-call events in compact mode update
    // the transient line themselves below, so don't pre-clear for those.
    if (event.agentName && event.type !== 'tool_call' && event.type !== 'tool_result') {
      this.transientStatusByAgent.delete(event.agentName);
    }

    if (event.type === 'reasoning') {
      this.upsertReasoningStep(event);
      return;
    }

    // tool_result closes a matching tool_call step (only when we created
    // one — in compact mode there is no row to close).
    if (event.type === 'tool_result') {
      const stepIdx = event.toolCallId
        ? this.toolCallStepIndex.get(event.toolCallId)
        : this.findLastActiveToolStepIndex();
      if (stepIdx !== undefined) {
        const step = this.timelineSteps[stepIdx];
        this.markStepCompleted(step, event.timestamp);
        step.durationMs = event.durationMs;
        step.toolResult = event.content;
        step.renderHint = event.renderHint;
        step.narration = this.buildToolResultNarration(step, event);
      } else if (event.agentName) {
        // Compact-mode tool result \u2014 keep the shimmer line alive briefly so
        // the user can still see what just happened. Real updates will
        // overwrite it.
        const friendly = event.friendlyMessage || 'Got results\u2026';
        this.transientStatusByAgent.set(event.agentName, friendly);
        this.agentTimelineGroups = this.buildAgentTimelineGroups();
      }
      return;
    }

    if (event.type === 'content') {
      const active = this.getActiveStepForAgent(event.agentName);
      if (!active) return;

      this.markStepCompleted(active, event.timestamp);
      active.durationMs = event.durationMs ?? active.durationMs;
      active.narration = this.buildCompletionNarration(active, event);
      return;
    }

    if (event.type === 'delegation') {
      this.finalizeActiveStep(event.timestamp);
      const step: TimelineStep = {
        id: `step-${event.timestamp}-${this.timelineSteps.length}`,
        type: 'delegation',
        label: event.friendlyMessage || `Asking ${event.agentName}…`,
        status: 'done',
        agentName: event.agentName,
        delegationContent: event.content,
        narration: this.buildDelegationNarration(event),
        expanded: false,
      };
      this.timelineSteps.push(step);
      if (this.isStreaming) {
        this.keepStepTemporarilyExpanded(step.id, event.timestamp);
      }
      return;
    }

    if (event.type === 'tool_call') {
      // Compact mode: once an agent has produced a reasoning step OR has
      // already shown one tool call this turn, route subsequent tool
      // activity to the transient shimmer line instead of stacking many
      // identical "Searching for information" rows. The reasoning panel
      // stays visible and one shimmer line below conveys live action.
      if (this.shouldUseCompactToolMode(event.agentName)) {
        const label = this.buildToolLabel(event);
        this.transientStatusByAgent.set(event.agentName, label);
        this.agentTimelineGroups = this.buildAgentTimelineGroups();
        return;
      }

      this.finalizeActiveStep(event.timestamp);
      const idx = this.timelineSteps.length;
      const step: TimelineStep = {
        id: `step-${event.timestamp}-${idx}`,
        type: 'tool',
        label: this.buildToolLabel(event),
        status: 'active',
        agentName: event.agentName,
        toolName: event.toolName,
        toolArgs: event.toolArgs,
        liveNarration: this.buildToolStartNarration(event),
        narration: this.buildToolStartNarration(event),
        expanded: true,
      };
      if (event.toolCallId) {
        this.toolCallStepIndex.set(event.toolCallId, idx);
      }
      this.timelineSteps.push(step);
    }
  }

  private findLastActiveToolStepIndex(): number | undefined {
    for (let i = this.timelineSteps.length - 1; i >= 0; i--) {
      if (this.timelineSteps[i].type === 'tool' && this.timelineSteps[i].status === 'active') {
        return i;
      }
    }
    return undefined;
  }

  private buildToolLabel(event: ChatterEvent): string {
    if (event.friendlyMessage) return event.friendlyMessage;
    if (!event.toolName) return 'Calling a tool…';
    const args = event.toolArgs;
    const friendly = this.humanizeToolName(event.toolName);
    if (args?.['query'])    return `Searching: "${this.truncateContent(String(args['query']), 50)}"`;
    if (args?.['question']) return `Looking up: "${this.truncateContent(String(args['question']), 50)}"`;
    return `Calling ${friendly}`;
  }

  private upsertPlanningStep(event: ChatterEvent): void {
    // THINKING events fire on every token-usage ping with canned labels like
    // "Thinking..." / "Processing information..." / "Analyzing results...".
    // They carry no unique narrative beyond `LLM call: N input, M output tokens`.
    // Once the agent has produced a real step (reasoning/tool/etc), promote
    // these to a transient shimmer-text status line on the agent group
    // instead of stacking them as steps. Behaves like GHCP's progress text.
    const isHeartbeat =
      !event.content || event.content.startsWith('LLM call:');
    const agentName = event.agentName;
    if (isHeartbeat && this.shouldSuppressHeartbeat(agentName)) {
      const label = event.friendlyMessage || 'Working…';
      this.transientStatusByAgent.set(agentName, label);
      // Force a group rebuild so the shimmer line updates with the new text.
      this.agentTimelineGroups = this.buildAgentTimelineGroups();
      return;
    }

    const label = event.friendlyMessage || 'Planning...';
    const active = this.getActiveStep();
    if (active?.type === 'planning' && active.agentName === agentName) {
      active.label = label;
      active.liveNarration = this.buildThinkingNarration(event);
      active.narration = this.buildThinkingSummary(event);
      active.expanded = true;
      return;
    }

    this.finalizeActiveStep();
    this.timelineSteps.push({
      id: `step-${event.timestamp}-${this.timelineSteps.length}`,
      type: 'planning',
      label,
      status: 'active',
      agentName,
      liveNarration: this.buildThinkingNarration(event),
      narration: this.buildThinkingSummary(event),
      expanded: true,
    });
  }

  /**
   * True if this agent has already produced a reasoning step or tool call
   * in this turn — meaning we already have meaningful progress narration
   * and should hide redundant generic "Thinking…" heartbeats.
   */
  private shouldSuppressHeartbeat(agentName: string): boolean {
    for (const step of this.timelineSteps) {
      if (step.agentName !== agentName) continue;
      if (step.type === 'reasoning' || step.type === 'tool') {
        return true;
      }
    }
    return false;
  }

  /**
   * True if this agent's tool calls should be collapsed into a single
   * shimmer line instead of stacked as separate steps. Triggered once
   * the agent has produced any reasoning step OR after the first tool
   * call (so we always show the first one expanded with input args, but
   * the next 12 "Searching for information" rows compress to a single
   * live status line).
   */
  private shouldUseCompactToolMode(agentName: string): boolean {
    // Compact mode activates after the agent already has at least one
    // visible tool step row.  This ensures the first tool call always
    // renders as a real row (giving the user something concrete to see),
    // while subsequent calls collapse into the shimmer line.
    let toolCount = 0;
    for (const step of this.timelineSteps) {
      if (step.agentName !== agentName) continue;
      if (step.type === 'tool') {
        toolCount++;
        if (toolCount >= 1) return true;
      }
    }
    return false;
  }

  private upsertReasoningStep(event: ChatterEvent): void {
    // Each backend chatter event for type=reasoning carries only the latest
    // delta from the model's reasoning_summary stream, not the cumulative
    // text. We accumulate deltas into the active reasoning step.
    const deltaText = (event.content || '').trim();
    const hasRealText = deltaText.length > 0;

    const active = this.getActiveStep();
    if (active?.type === 'reasoning' && active.agentName === event.agentName) {
      if (hasRealText) {
        const previous = (active.reasoningText || '').trim();
        // Avoid duplicating when the same delta is replayed (e.g. CUSTOM
        // event re-emits the same content already accumulated by AG-UI).
        if (!previous || !previous.endsWith(deltaText)) {
          active.reasoningText = previous
            ? `${previous}${this.needsSpaceJoin(previous, deltaText) ? ' ' : ''}${deltaText}`
            : deltaText;
        }
        active.label = 'Thinking';
        active.liveNarration = undefined;
        active.narration = undefined;
      } else if (!active.reasoningText) {
        active.label = event.friendlyMessage || 'Analyzing...';
        active.liveNarration = this.buildReasoningNarration(active.agentName, true);
        active.narration = this.buildReasoningNarration(active.agentName, false);
      }
      active.expanded = true;
      this.scrollActiveReasoningToBottom();
      return;
    }

    this.finalizeActiveStep();
    this.timelineSteps.push({
      id: `step-${event.timestamp}-${this.timelineSteps.length}`,
      type: 'reasoning',
      label: hasRealText ? 'Thinking' : (event.friendlyMessage || 'Analyzing...'),
      status: 'active',
      agentName: event.agentName,
      reasoningText: hasRealText ? deltaText : undefined,
      liveNarration: hasRealText ? undefined : this.buildReasoningNarration(event.agentName, true),
      narration: hasRealText ? undefined : this.buildReasoningNarration(event.agentName, false),
      expanded: true,
    });
    this.scrollActiveReasoningToBottom();
  }

  /** Scroll the active reasoning panel's text area to the bottom. */
  private scrollActiveReasoningToBottom(): void {
    requestAnimationFrame(() => {
      const panels = document.querySelectorAll('.tl-reasoning-streaming .tl-reasoning-text');
      panels.forEach(el => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  /** True if joining `prev` and `next` requires a separator space. */
  private needsSpaceJoin(prev: string, next: string): boolean {
    if (!prev || !next) return false;
    const lastChar = prev[prev.length - 1];
    const firstChar = next[0];
    // No space needed if either side already has whitespace or punctuation that flows.
    if (/\s/.test(lastChar) || /\s/.test(firstChar)) return false;
    if (/[.,;:!?\-\(]/.test(lastChar)) return true;
    return /\w/.test(lastChar) && /\w/.test(firstChar);
  }

  private getActiveStep(): TimelineStep | undefined {
    return [...this.timelineSteps].reverse().find(step => step.status === 'active');
  }

  private getActiveStepForAgent(agentName: string): TimelineStep | undefined {
    return [...this.timelineSteps]
      .reverse()
      .find(step => step.status === 'active' && step.agentName === agentName);
  }

  private finalizeActiveStep(completedAt?: number): void {
    const active = this.getActiveStep();
    if (!active) return;

    this.markStepCompleted(active, completedAt);
  }

  private markStepCompleted(step: TimelineStep, completedAt?: number): void {
    step.status = 'done';
    step.liveNarration = undefined;
    // Reasoning panels stay expanded so the user can read them. Everything
    // else collapses on completion (with a brief grace period via
    // keepStepTemporarilyExpanded while streaming).
    if (step.type === 'reasoning') {
      step.expanded = true;
      return;
    }
    step.expanded = false;
    if (this.isStreaming) {
      this.keepStepTemporarilyExpanded(step.id, completedAt);
    }
  }

  private keepStepTemporarilyExpanded(stepId: string, startedAt?: number): void {
    const now = Date.now();
    const baseTime = startedAt ?? now;
    const expiresAt = baseTime + this.recentCompletionOpenMs;
    if (expiresAt <= now) {
      this.clearTransientExpansion(stepId);
      return;
    }

    this.transientExpandedSteps.set(stepId, expiresAt);

    const existingTimer = this.transientCollapseTimers.get(stepId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.transientCollapseTimers.delete(stepId);
      const deadline = this.transientExpandedSteps.get(stepId);
      if (deadline && deadline <= Date.now()) {
        this.transientExpandedSteps.delete(stepId);
        this.timelineSteps = [...this.timelineSteps];
        this.agentTimelineGroups = this.buildAgentTimelineGroups();
      }
    }, Math.max(0, expiresAt - now) + 50);

    this.transientCollapseTimers.set(stepId, timer);
  }

  private clearTransientExpansion(stepId: string): void {
    this.transientExpandedSteps.delete(stepId);
    const timer = this.transientCollapseTimers.get(stepId);
    if (timer) {
      clearTimeout(timer);
      this.transientCollapseTimers.delete(stepId);
    }
  }

  private isStepTemporarilyExpanded(stepId: string): boolean {
    const deadline = this.transientExpandedSteps.get(stepId);
    if (!deadline) {
      return false;
    }
    if (deadline <= Date.now()) {
      this.clearTransientExpansion(stepId);
      return false;
    }
    return true;
  }

  private buildTimelineSignature(): string {
    return JSON.stringify({
      isStreaming: this.isStreaming,
      chatterEvents: this.getChatterEvents().map(event => ({
        type: event.type,
        agentName: event.agentName,
        content: event.content,
        toolName: event.toolName,
        toolArgs: event.toolArgs,
        toolCallId: event.toolCallId,
        durationMs: event.durationMs,
        tokensInput: event.tokensInput,
        tokensOutput: event.tokensOutput,
        friendlyMessage: event.friendlyMessage,
        renderHint: event.renderHint,
      })),
    });
  }

  private buildAgentTimelineGroups(): AgentTimelineGroup[] {
    const groups: AgentTimelineGroup[] = [];
    let currentGroup: AgentTimelineGroup | undefined;

    for (const step of this.timelineSteps) {
      const agentName = step.agentName || 'Agent';
      const role = this.getAgentRole(agentName);

      if (currentGroup && currentGroup.agentName === agentName && currentGroup.role === role) {
        currentGroup.steps.push(step);
        currentGroup.hasActiveStep = currentGroup.hasActiveStep || step.status === 'active';
        continue;
      }

      currentGroup = {
        id: `group-${groups.length}-${agentName}`,
        agentName,
        role,
        steps: [step],
        hasActiveStep: step.status === 'active',
      };
      groups.push(currentGroup);
    }

    // Attach transient shimmer-text status to the most recent group for
    // each agent that is still active. Only render while streaming.
    if (this.isStreaming) {
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (!g.hasActiveStep) continue;
        const txt = this.transientStatusByAgent.get(g.agentName);
        if (txt) g.transientStatus = txt;
      }
    }

    return groups;
  }

  getAgentGroupIcon(group: AgentTimelineGroup): string {
    switch (group.role) {
      case 'orchestrator':
        return 'hub';
      case 'assistant':
        return 'smart_toy';
      default:
        return 'engineering';
    }
  }

  getAgentGroupSubtitle(group: AgentTimelineGroup): string {
    if (group.hasActiveStep) {
      return `Currently working on ${group.steps[group.steps.length - 1]?.label?.toLowerCase() || 'the next step'}`;
    }
    const lastStep = group.steps[group.steps.length - 1];
    if (!lastStep) {
      return 'No specialist activity yet';
    }
    switch (lastStep.type) {
      case 'delegation':
        return 'Coordinated the next specialist handoff';
      case 'tool':
        return 'Used tools to gather or process information';
      case 'reasoning':
        return 'Analyzed the request before responding';
      case 'planning':
        return 'Reviewed the task and planned the next action';
      default:
        return 'Worked on part of the response';
    }
  }

  getIdleWorkingLabel(): string {
    const activeGroup = this.agentTimelineGroups.find(group => group.hasActiveStep);
    if (activeGroup) {
      return `${activeGroup.agentName} is still working…`;
    }
    const recentGroup = this.agentTimelineGroups[this.agentTimelineGroups.length - 1];
    if (recentGroup) {
      return `Waiting for ${recentGroup.agentName} to continue…`;
    }
    return 'Preparing specialist work…';
  }

  private getAgentRole(agentName: string): AgentTimelineGroup['role'] {
    const normalized = agentName.trim().toLowerCase();
    if (normalized === 'assistant') {
      return 'assistant';
    }
    if (normalized.includes('orchestrator')) {
      return 'orchestrator';
    }
    return 'specialist';
  }

  canExpandStep(step: TimelineStep): boolean {
    return this.hasStepDetailText(step)
      || this.hasReasoningText(step)
      || (step.toolArgs ? this.hasToolArgs(step.toolArgs) : false)
      || !!step.toolResult
      || !!step.delegationContent;
  }

  isStepExpanded(step: TimelineStep): boolean {
    return step.status === 'active' ? true : step.expanded || this.isStepTemporarilyExpanded(step.id);
  }

  hasStepDetailText(step: TimelineStep): boolean {
    return !!this.getStepDetailText(step);
  }

  hasReasoningText(step: TimelineStep): boolean {
    return !!(step.reasoningText && step.reasoningText.trim().length > 0);
  }

  getStepDetailText(step: TimelineStep): string {
    return step.status === 'active' ? (step.liveNarration || '') : (step.narration || '');
  }

  private buildThinkingNarration(event: ChatterEvent): string | undefined {
    if (event.content && !event.content.startsWith('LLM call:')) {
      return this.truncateContent(event.content, 220);
    }
    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }
    if (event.tokensInput || event.tokensOutput) {
      const input = this.formatTokenCount(event.tokensInput);
      const output = this.formatTokenCount(event.tokensOutput);
      return `Reviewing context with ${input} input tokens and ${output} output tokens generated so far.`;
    }
    return 'The model is evaluating the request and deciding the next action.';
  }

  private buildThinkingSummary(event: ChatterEvent): string {
    if (event.content && !event.content.startsWith('LLM call:')) {
      return this.truncateContent(event.content, 160);
    }
    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }
    return 'Reviewed the current context and decided the next step.';
  }

  private buildReasoningNarration(agentName: string, active: boolean): string {
    if (active) {
      return `${agentName} is weighing the available information before drafting a response.`;
    }
    return `${agentName} analyzed the available information before drafting the response.`;
  }

  private buildDelegationNarration(event: ChatterEvent): string {
    if (event.content) {
      return this.truncateContent(event.content, 180);
    }
    if (event.friendlyMessage) {
      return `${event.friendlyMessage}.`;
    }
    return 'Delegated work to a specialist.';
  }

  private buildToolStartNarration(event: ChatterEvent): string {
    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }
    if (event.toolName) {
      return `${event.agentName} is preparing ${this.humanizeToolName(event.toolName)} and waiting for the result.`;
    }
    return `${event.agentName} is calling a tool.`;
  }

  private buildToolResultNarration(step: TimelineStep, event: ChatterEvent): string {
    if (step.toolName) {
      const duration = event.durationMs ? ` in ${this.formatDuration(event.durationMs)}` : '';
      return `${this.humanizeToolName(step.toolName)} completed${duration}.`;
    }
    return 'Tool call completed.';
  }

  private buildCompletionNarration(step: TimelineStep, event: ChatterEvent): string {
    if (event.content && !event.content.startsWith('Completed')) {
      return this.truncateContent(event.content, 180);
    }

    if (step.type === 'tool' && step.toolName) {
      return this.buildToolResultNarration(step, event);
    }

    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }

    if (event.durationMs) {
      return `${event.agentName} finished in ${this.formatDuration(event.durationMs)}.`;
    }

    return `${event.agentName} finished the current step.`;
  }

  /** Toggle expanded state of a timeline step. */
  toggleStep(step: TimelineStep): void {
    if (step.status === 'active') return;
    const expanded = this.isStepExpanded(step);
    if (expanded) {
      step.expanded = false;
      this.clearTransientExpansion(step.id);
      return;
    }

    step.expanded = true;
    this.clearTransientExpansion(step.id);
  }

  /** Return the right Material icon for a given step. */
  getStepIcon(step: TimelineStep): string {
    if (step.status === 'done') return 'check_circle';
    switch (step.type) {
      case 'planning':    return 'lightbulb';
      case 'tool':        return 'search';
      case 'delegation':  return 'forward';
      case 'reasoning':   return 'neurology';
      default:            return 'sync';
    }
  }

  hasChatterEvents(): boolean {
    return !!(this.message as DisplayMessage).chatterEvents?.length;
  }
  
  getChatterEvents(): ChatterEvent[] {
    return (this.message as DisplayMessage).chatterEvents || [];
  }
  
  hasToolArgs(args: Record<string, unknown> | undefined): boolean {
    return !!args && Object.keys(args).length > 0;
  }
  
  getChatterIcon(type: string): string {
    switch (type) {
      case 'tool_call': return 'build';
      case 'tool_result': return 'check_circle';
      case 'delegation': return 'forward';
      case 'thinking': return 'psychology';
      case 'reasoning': return 'neurology';
      default: return 'info';
    }
  }
  
  formatChatterType(type: string): string {
    switch (type) {
      case 'tool_call': return 'calling tool';
      case 'tool_result': return 'got result';
      case 'delegation': return 'delegating';
      case 'thinking': return 'thinking';
      case 'reasoning': return 'reasoning';
      default: return type;
    }
  }
  
  formatToolArgs(args?: Record<string, unknown>): string {
    if (!args) return '';
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  
  formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}m ${seconds}s`;
    }
  }
  
  formatTokenCount(count?: number): string {
    if (!count) return '0';
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  }
  
  getTokensTooltip(input?: number, output?: number): string {
    const inputVal = input || 0;
    const outputVal = output || 0;
    const total = inputVal + outputVal;
    return `Token usage for this LLM call:\n• Input: ${inputVal.toLocaleString()} tokens (context sent to model)\n• Output: ${outputVal.toLocaleString()} tokens (response generated)\n• Total: ${total.toLocaleString()} tokens`;
  }
  
  truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  }

  formatJson(content: string): string {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }

  renderTable(content: string): string {
    const lines = content.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return this.escapeHtml(content);

    // Detect delimiter: pipes or tabs
    const usesPipes = lines[0].includes('|');
    const delim = usesPipes ? '|' : '\t';

    const rows = lines
      .filter(l => !l.match(/^[\s|:-]+$/))  // skip separator rows like |---|---|
      .map(l => {
        const cells = l.split(delim).map(c => c.trim()).filter(c => c !== '');
        return cells;
      })
      .filter(r => r.length > 0);

    if (rows.length === 0) return this.escapeHtml(content);

    const headerCells = rows[0].map(c => `<th>${this.escapeHtml(c)}</th>`).join('');
    const bodyRows = rows.slice(1)
      .map(r => '<tr>' + r.map(c => `<td>${this.escapeHtml(c)}</td>`).join('') + '</tr>')
      .join('');

    return `<table class="tool-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Get a simplified icon for the activity feed
   */
  getActivityIcon(type: string): string {
    switch (type) {
      case 'tool_call': return 'search';
      case 'tool_result': return 'check_circle';
      case 'delegation': return 'arrow_forward';
      case 'thinking': return 'lightbulb';
      case 'reasoning': return 'neurology';
      case 'content': return 'done_all';
      default: return 'info';
    }
  }
  
  /**
   * Get a user-friendly message for the activity feed
   * Uses the friendlyMessage if available, otherwise falls back to content
   */
  getActivityMessage(event: ChatterEvent): string {
    // Prefer the friendly message from backend
    if (event.friendlyMessage) {
      return event.friendlyMessage;
    }
    
    // Fallback: generate friendly message from event type and content
    switch (event.type) {
      case 'tool_call':
        return event.toolName ? `Using ${this.humanizeToolName(event.toolName)}...` : 'Calling a tool...';
      case 'tool_result':
        return 'Got results';
      case 'delegation':
        return event.content ? `Asking: "${this.truncateContent(event.content, 60)}"` : 'Delegating task...';
      case 'thinking':
        return 'Processing...';
      case 'reasoning':
        return event.content ? this.truncateContent(event.content, 80) : 'Reasoning...';
      case 'content':
        return event.content || 'Completed';
      default:
        return event.content || 'Working...';
    }
  }
  
  /**
   * Convert tool names to more readable format
   */
  private humanizeToolName(toolName: string): string {
    return toolName
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase();
  }

  /** Extract the filename from a URL, stripping query params and path. */
  private extractFileName(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const name = decodeURIComponent(pathname.split('/').pop() || 'document');
      return name;
    } catch {
      const lastSegment = url.split('/').pop() || 'document';
      return lastSegment.split('?')[0];
    }
  }

  /** Build the HTML for a download card. */
  private buildDownloadCard(url: string, fileName: string): string {
    return `<div class="mcp-download-card">` +
      `<span class="material-icons mcp-download-icon">description</span>` +
      `<span class="mcp-download-name" title="${fileName}">${fileName}</span>` +
      `<a href="${url}" class="mcp-download-btn" target="_blank" rel="noopener noreferrer">` +
      `<span class="material-icons">download</span> Download</a></div>`;
  }

  /** Trigger a browser file download from a fetched blob response. */
  private triggerDownload(body: Blob | null, fileName: string, contentType: string | null): void {
    if (!body) return;
    const blobUrl = URL.createObjectURL(new Blob([body], { type: contentType || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }

  /**
   * Parse input fields from the assistant message content.
   * Only shown on the last assistant message and when role is 'assistant'.
   * Results are cached to avoid re-parsing on every change detection cycle.
   */
  getParsedFields(): ParsedInputField[] {
    const assistantAgentId = this.message.metadata?.['assistant_agent_id'];
    if (
      this.message.role !== 'assistant'
      || !this.isLastAssistantMessage
      || typeof assistantAgentId !== 'string'
      || !this.structuredFormAgentIds.includes(assistantAgentId)
    ) {
      return [];
    }
    if (this.cachedContent === this.message.content) {
      return this.cachedParsedFields || [];
    }
    this.cachedContent = this.message.content;
    this.cachedParsedFields = parseInputFields(this.message.content);
    return this.cachedParsedFields;
  }

  onWizardSubmit(formText: string): void {
    this.formSubmitted = true;
    this.formSubmit.emit(formText);
  }
}
