import { Component, OnInit, OnDestroy } from '@angular/core';
import { MsalService } from '@azure/msal-angular';
import { Subject, takeUntil } from 'rxjs';
import { SettingsService } from '../../../core/services/settings.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [],
  template: `
    <header class="header">
      <div class="header-left">
        <!-- Agent info now shown in chat component -->
      </div>

      <div class="header-center">
        @if (brandingImage) {
          <img [src]="brandingImage" alt="App branding" class="header-branding-image" />
        }
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
      flex: 1;
    }

    .header-center {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
    }

    .header-branding-image {
      max-height: 38px;
      max-width: 200px;
      object-fit: contain;
    }
    
    .header-right {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex: 1;
      justify-content: flex-end;
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
export class HeaderComponent implements OnInit, OnDestroy {
  brandingImage?: string | null;
  private destroy$ = new Subject<void>();

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
  
  constructor(
    private authService: MsalService,
    private settingsService: SettingsService
  ) {}

  ngOnInit(): void {
    this.settingsService.settings$
      .pipe(takeUntil(this.destroy$))
      .subscribe(settings => {
        this.brandingImage = (settings.branding_image && settings.branding_image_position === 'header')
          ? settings.branding_image
          : null;
      });
  }
  
  logout(): void {
    this.authService.logout();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
