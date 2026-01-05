import { Component, signal, inject, computed, ElementRef, ViewChild, AfterViewInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatBadgeModule } from '@angular/material/badge';
import { AgentActivityService, AgentActivity, AgentStatus } from '../services/agent-activity-socketio.service';

@Component({
  selector: 'app-agent-activity',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatExpansionModule,
    MatBadgeModule
  ],
  template: `
    <div class="agent-activity-panel">
      <!-- Header without toggle -->
      <div class="panel-header">
        <div class="header-content">
          <mat-icon>smart_toy</mat-icon>
          <span class="panel-title">Agent Activity</span>
          @if (activeAgentCount() > 0) {
            <mat-chip class="active-count" color="accent">
              {{ activeAgentCount() }} active
            </mat-chip>
          }        </div>
        <div class="header-buttons">
          <button mat-icon-button (click)="testActivity()" matTooltip="Test agent activity" class="test-button">
            <mat-icon>play_arrow</mat-icon>
          </button>
          <button mat-icon-button (click)="clearActivities()" matTooltip="Clear activities" class="clear-button">
            <mat-icon>clear_all</mat-icon>
          </button>
        </div>
      </div>

      <!-- Always visible content -->
      <div class="panel-content">
        <!-- Recent Activities -->
        <div class="activities-section">
          @if (recentActivities().length > 0) {
            <div class="activities-list" #activityList>              @for (activity of recentActivities(); track activity.id; let i = $index) {
                <div class="activity-item" 
                     [class]="'status-' + activity.status"
                     [style.animation-delay]="getAnimationDelay(i) + 'ms'">
                  <div class="activity-icon">
                    <mat-icon [class]="'status-' + activity.status">
                      {{ getActivityIcon(activity.status) }}
                    </mat-icon>
                  </div>
                    <div class="activity-content">
                    <div class="activity-header">
                      <span class="agent-name">{{ activity.agentName }}</span>
                      <span class="activity-time">{{ formatTime(activity.timestamp) }}</span>
                    </div>
                    
                    <div class="activity-action">
                      {{ activity.action }}
                      @if (activity.status === 'in-progress') {
                        <span class="typing-indicator">
                          <span class="dot"></span>
                          <span class="dot"></span>
                          <span class="dot"></span>
                        </span>
                      }
                    </div>
                    
                    @if (activity.details) {
                      <div class="activity-details">{{ activity.details }}</div>
                    }
                    
                    @if (activity.duration) {
                      <div class="activity-duration">
                        Completed in {{ formatDuration(activity.duration) }}
                      </div>
                    }
                  </div>
                  
                  @if (activity.status === 'in-progress') {
                    <div class="activity-progress">
                      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
                    </div>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="no-activities">
              <mat-icon>history</mat-icon>
              <p>No recent agent activity</p>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`    .agent-activity-panel {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
      margin: 16px;
      overflow: hidden;
      transition: all 0.3s ease;      display: flex;
      flex-direction: column;
      height: calc(100vh - 32px); /* Take full height minus margin */
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      user-select: none;
    }

    .header-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .panel-title {
      font-weight: 600;
      font-size: 16px;
    }    .active-count {
      font-size: 12px;
      height: 24px;
    }

    .header-buttons {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .test-button, .clear-button {
      color: white;
    }

    .test-button:hover, .clear-button:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .panel-content {
      padding: 20px;
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .activities-section {
      width: 100%;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .activities-list {
      flex: 1;
      overflow-y: auto;
      scroll-behavior: smooth;
      padding-bottom: 10px;
    }

    .activities-list::-webkit-scrollbar {
      width: 6px;
    }

    .activities-list::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 3px;
    }

    .activities-list::-webkit-scrollbar-thumb {
      background: #c1c1c1;
      border-radius: 3px;
    }

    .activities-list::-webkit-scrollbar-thumb:hover {
      background: #a8a8a8;
    }

    .agent-card.status-error {
      border-color: #f44336;
      background: #ffebee;
    }

    .agent-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .agent-info {
      display: flex;
      gap: 12px;
    }

    .agent-icon {
      font-size: 24px;
      width: 24px;
      height: 24px;
    }

    .agent-icon.status-active {
      color: #4caf50;
    }

    .agent-icon.status-error {
      color: #f44336;
    }

    .agent-icon.status-idle {
      color: #9e9e9e;
    }

    .agent-details {
      flex: 1;
    }

    .agent-name {
      font-weight: 600;
      font-size: 14px;
      color: #333;
    }

    .agent-domains {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 4px;
    }

    .domain-chip {
      font-size: 10px;
      height: 20px;
      background: #e3f2fd;
      color: #1976d2;
    }

    .more-domains {
      font-size: 10px;
      color: #666;
      margin-left: 4px;
    }

    .agent-status {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    .status-indicator.status-active {
      background: #4caf50;
    }

    .status-indicator.status-error {
      background: #f44336;
    }

    .status-indicator.status-idle {
      background: #9e9e9e;
      animation: none;
    }

    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }

    .status-text {
      font-size: 12px;
      font-weight: 500;
      text-transform: capitalize;
    }

    .current-activity {
      background: rgba(76, 175, 80, 0.1);
      border-radius: 8px;
      padding: 8px;
      margin-top: 8px;
    }

    .activity-text {
      font-size: 12px;
      color: #333;
      margin-bottom: 4px;
    }

    .activity-progress {
      height: 2px;
    }

    .last-activity {
      font-size: 11px;
      color: #666;
      margin-top: 8px;
    }    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .activities-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }    .activity-item {
      display: flex;
      gap: 12px;
      padding: 16px;
      margin-bottom: 8px;
      background: white;
      border-radius: 12px;
      border-left: 4px solid #e0e0e0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
      transition: all 0.3s ease;
      
      /* Smooth entrance animation like GitHub Copilot */
      animation: slideInFromBottom 0.4s ease-out;
      opacity: 0;
      animation-fill-mode: forwards;
    }

    @keyframes slideInFromBottom {
      0% {
        opacity: 0;
        transform: translateY(20px);
      }
      50% {
        opacity: 0.7;
        transform: translateY(5px);
      }
      100% {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .activity-item:hover {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }    .activity-item.status-completed {
      border-left-color: #4caf50;
      background: #f8fff9;
    }

    .activity-item.status-error {
      border-left-color: #f44336;
      background: #fff8f8;
    }

    .activity-item.status-in-progress {
      border-left-color: #2196f3;
      background: #f8fbff;
    }

    .activity-item.status-completed .activity-icon {
      background: #e8f5e8;
    }

    .activity-item.status-error .activity-icon {
      background: #ffeaea;
    }    .activity-item.status-in-progress .activity-icon {
      background: #e3f2fd;
    }

    .activity-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #f0f0f0;
      flex-shrink: 0;
    }

    .activity-icon mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .activity-icon mat-icon.status-completed {
      color: #4caf50;
    }

    .activity-icon mat-icon.status-error {
      color: #f44336;
    }    .activity-icon mat-icon.status-in-progress {
      color: #2196f3;
    }

    .activity-content {
      flex: 1;
      min-width: 0; // Allows text wrapping
    }

    .activity-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }

    .activity-header .agent-name {
      font-weight: 600;
      font-size: 13px;
      color: #555;
      text-transform: capitalize;
    }

    .activity-time {
      font-size: 11px;
      color: #999;
    }

    .activity-action {
      font-size: 14px;
      font-weight: 500;
      color: #333;
      margin-bottom: 6px;
      line-height: 1.4;
    }

    .activity-details {
      font-size: 12px;
      color: #666;
      background: rgba(0, 0, 0, 0.05);
      padding: 8px 10px;
      border-radius: 6px;
      margin-bottom: 6px;
      line-height: 1.4;
      word-wrap: break-word;      max-height: 100px;
      overflow-y: auto;
    }

    .activity-duration {
      font-size: 11px;
      color: #4caf50;
      font-weight: 500;
    }

    .activity-progress {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
    }

    .no-activities {
      text-align: center;
      padding: 40px 20px;
      color: #666;
    }

    .no-activities mat-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      color: #ccc;
      margin-bottom: 16px;
    }

    .no-activities p {
      margin: 0;
      font-size: 14px;
    }

    /* Typing indicator animation */
    .typing-indicator {
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
      gap: 2px;
    }

    .typing-indicator .dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background-color: #2196f3;
      animation: typingAnimation 1.4s infinite ease-in-out;
    }

    .typing-indicator .dot:nth-child(1) {
      animation-delay: -0.32s;
    }

    .typing-indicator .dot:nth-child(2) {
      animation-delay: -0.16s;
    }

    .typing-indicator .dot:nth-child(3) {
      animation-delay: 0s;
    }

    @keyframes typingAnimation {
      0%, 80%, 100% {
        transform: scale(0.8);
        opacity: 0.5;
      }
      40% {
        transform: scale(1);
        opacity: 1;
      }
    }
  `]
})
export class AgentActivityComponent implements AfterViewInit, OnDestroy {
  agentActivityService = inject(AgentActivityService);
  @ViewChild('activityList') activityList!: ElementRef;
  activeAgentCount = computed(() => 
    this.agentActivityService.getAgentStatuses().filter((agent: AgentStatus) => agent.status === 'active').length
  );

  recentActivities = computed(() => {
    // Activities are already in chronological order (oldest to newest)
    return this.agentActivityService.getActivities();
  });
  constructor() {
    // Auto-scroll to bottom when new activities are added with a proper delay
    effect(() => {
      const activities = this.recentActivities();
      if (activities.length > 0) {
        // Use longer timeout to ensure DOM is updated and animations start
        // Schedule scroll after animations have time to start
        setTimeout(() => this.smoothScrollToBottom(), 300);
      }
    });
  }
  clearActivities(): void {
    this.agentActivityService.clearActivities();
  }

  testActivity(): void {
    // Generate a test session ID
    const testSessionId = 'test-session-' + Date.now();
    console.log('🧪 Testing agent activity for session:', testSessionId);
    
    // First join the test session
    this.agentActivityService.joinSession(testSessionId);
    
    // Wait a moment then trigger a test activity from the backend
    setTimeout(() => {
      fetch(`http://localhost:5007/api/test/activity/${testSessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      .then(response => response.json())
      .then(data => {
        console.log('✅ Test activity triggered:', data);
      })
      .catch(error => {
        console.error('❌ Error triggering test activity:', error);
      });
    }, 1000);
  }

  getAgentIcon(agentId: string): string {
    switch (agentId) {
      case 'core-agent': return 'settings';
      case 'adx-agent': return 'analytics';
      case 'maps-agent': return 'map';
      case 'documents-agent': return 'description';
      case 'resources-agent': return 'cloud';
      default: return 'smart_toy';
    }
  }

  getActivityIcon(status: AgentActivity['status']): string {
    switch (status) {
      case 'starting': return 'play_arrow';
      case 'in-progress': return 'sync';
      case 'completed': return 'check_circle';
      case 'error': return 'error';
      default: return 'help';
    }
  }

  formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) { // Less than 1 minute
      return `${Math.floor(diff / 1000)}s ago`;
    } else if (diff < 3600000) { // Less than 1 hour
      return `${Math.floor(diff / 60000)}m ago`;
    } else {
      return date.toLocaleTimeString();
    }
  }

  formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else {
      return `${(ms / 60000).toFixed(1)}m`;
    }
  }

  getAnimationDelay(index: number): number {
    // Stagger animations for the last few items only (most recent)
    const totalActivities = this.recentActivities().length;
    const recentItemsCount = Math.min(5, totalActivities); // Only animate last 5 items
    const isRecentItem = index >= totalActivities - recentItemsCount;
    
    if (isRecentItem) {
      const recentIndex = index - (totalActivities - recentItemsCount);
      return recentIndex * 100; // 100ms stagger between items
    }
    
    return 0; // No delay for older items
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }
  private scrollToBottom(): void {
    if (this.activityList?.nativeElement) {
      this.activityList.nativeElement.scrollTop = this.activityList.nativeElement.scrollHeight;
    }
  }

  private smoothScrollToBottom(): void {
    if (this.activityList?.nativeElement) {
      const element = this.activityList.nativeElement;
      const targetScrollTop = element.scrollHeight;
      const startScrollTop = element.scrollTop;
      const distance = targetScrollTop - startScrollTop;
      
      // Only scroll if we're not already at the bottom
      if (Math.abs(distance) > 10) {
        element.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth'
        });
      }
    }
  }
}
