import { Component } from '@angular/core';
import { MsalService } from '@azure/msal-angular';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [],
  template: `
    <header class="header">
      <div class="header-left">
        <!-- Agent info now shown in chat component -->
      </div>
      
      <div class="header-right">
        @if (userName) {
          <div class="user-info">
            <span class="user-avatar">{{ userInitials }}</span>
            <span class="user-name">{{ userName }}</span>
          </div>
        }
        <button class="btn btn-icon" (click)="logout()" title="Sign out">
          <span class="material-icons">logout</span>
        </button>
      </div>
    </header>
  `,
  styles: [`
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      background-color: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      height: 56px;
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }
    
    .user-info {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }
    
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background-color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
    }
    
    .user-name {
      color: var(--text-secondary);
      font-size: 14px;
    }
  `]
})
export class HeaderComponent {
  get userName(): string | undefined {
    const account = this.authService.instance.getActiveAccount();
    return account?.name;
  }
  
  get userInitials(): string {
    const name = this.userName || '';
    return name.split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  
  constructor(private authService: MsalService) {}
  
  logout(): void {
    this.authService.logout();
  }
}
