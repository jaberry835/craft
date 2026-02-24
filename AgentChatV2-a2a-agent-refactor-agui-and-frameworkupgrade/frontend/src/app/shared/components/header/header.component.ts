import { Component, OnInit, OnDestroy, HostListener, ElementRef } from '@angular/core';
import { MsalService } from '@azure/msal-angular';
import { Subject, takeUntil } from 'rxjs';
import { SettingsService } from '../../../core/services/settings.service';
import { PreferencesService } from '../../../core/services/preferences.service';

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
        <div class="user-menu-container">
          <button class="user-menu-trigger" (click)="toggleMenu($event)">
            <span class="user-avatar">{{ userInitials }}</span>
            @if (userName) {
              <span class="user-name">{{ userName }}</span>
            }
            <span class="material-icons menu-chevron" [class.open]="menuOpen">expand_more</span>
          </button>
          
          @if (menuOpen) {
            <div class="user-dropdown">
              <div class="dropdown-header">
                <span class="user-avatar lg">{{ userInitials }}</span>
                <div class="dropdown-user-info">
                  <span class="dropdown-name">{{ userName }}</span>
                  <span class="dropdown-email">{{ userEmail }}</span>
                </div>
              </div>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item" (click)="toggleTheme()">
                <span class="material-icons">{{ currentTheme === 'dark' ? 'light_mode' : 'dark_mode' }}</span>
                <span>{{ currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode' }}</span>
              </button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item danger" (click)="logout()">
                <span class="material-icons">logout</span>
                <span>Sign Out</span>
              </button>
            </div>
          }
        </div>
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
      position: relative;
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex: 1;
    }

    .header-center {
      position: absolute;
      left: calc(50vw - 280px);
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
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

    /* User menu trigger */
    .user-menu-container {
      position: relative;
    }

    .user-menu-trigger {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 4px 8px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      cursor: pointer;
      color: var(--text-primary);
      transition: all var(--transition-fast);

      &:hover {
        background-color: var(--bg-hover);
        border-color: var(--border-color);
      }
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
      color: #fff;
      flex-shrink: 0;

      &.lg {
        width: 40px;
        height: 40px;
        font-size: 14px;
      }
    }
    
    .user-name {
      color: var(--text-secondary);
      font-size: 14px;
    }

    .menu-chevron {
      font-size: 18px;
      color: var(--text-muted);
      transition: transform var(--transition-fast);
      &.open { transform: rotate(180deg); }
    }

    /* Dropdown */
    .user-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      width: 260px;
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: var(--shadow);
      z-index: 1000;
      overflow: hidden;
      animation: dropIn 150ms ease-out;
    }

    @keyframes dropIn {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .dropdown-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
    }

    .dropdown-user-info {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .dropdown-name {
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dropdown-email {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dropdown-divider {
      height: 1px;
      background-color: var(--border-color);
    }

    .dropdown-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      width: 100%;
      padding: 10px var(--spacing-md);
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
      transition: background-color var(--transition-fast);

      .material-icons {
        font-size: 20px;
        color: var(--text-muted);
      }

      &:hover {
        background-color: var(--bg-hover);
      }

      &.danger {
        color: var(--danger);
        .material-icons { color: var(--danger); }
      }
    }
  `]
})
export class HeaderComponent implements OnInit, OnDestroy {
  brandingImage?: string | null;
  menuOpen = false;
  currentTheme: 'dark' | 'light' = 'dark';
  private destroy$ = new Subject<void>();

  get userName(): string | undefined {
    const account = this.authService.instance.getActiveAccount();
    return account?.name;
  }

  get userEmail(): string | undefined {
    const account = this.authService.instance.getActiveAccount();
    return account?.username;
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
    private settingsService: SettingsService,
    private preferencesService: PreferencesService,
    private elRef: ElementRef
  ) {}

  ngOnInit(): void {
    this.settingsService.settings$
      .pipe(takeUntil(this.destroy$))
      .subscribe(settings => {
        this.brandingImage = (settings.branding_image && settings.branding_image_position === 'header')
          ? settings.branding_image
          : null;
      });

    this.preferencesService.preferences$
      .pipe(takeUntil(this.destroy$))
      .subscribe(prefs => {
        this.currentTheme = prefs.theme;
      });
  }

  toggleMenu(event: Event): void {
    event.stopPropagation();
    this.menuOpen = !this.menuOpen;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (this.menuOpen && !this.elRef.nativeElement.contains(event.target)) {
      this.menuOpen = false;
    }
  }

  toggleTheme(): void {
    const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    this.preferencesService.updatePreferences({ theme: newTheme }).subscribe();
    this.menuOpen = false;
  }

  logout(): void {
    this.menuOpen = false;
    this.authService.logout();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
