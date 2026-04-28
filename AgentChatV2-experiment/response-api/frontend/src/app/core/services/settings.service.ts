import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, catchError, of } from 'rxjs';
import { environment } from '@env/environment';

export interface ClassificationBanner {
  enabled: boolean;
  text: string;
  background_color: string;
  foreground_color: string;
}

export interface UISettings {
  id?: string;
  classification_banner: ClassificationBanner;
  branding_image?: string | null;
  branding_image_filename?: string | null;
  branding_image_position?: string;
  app_title?: string | null;
  assistant_display_name?: string | null;
  favicon_image?: string | null;
  favicon_image_filename?: string | null;
  updated_at?: string | null;
}

const DEFAULT_SETTINGS: UISettings = {
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

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private settingsSubject = new BehaviorSubject<UISettings>(DEFAULT_SETTINGS);
  public settings$ = this.settingsSubject.asObservable();

  private loaded = false;

  constructor(private http: HttpClient) {}

  /** Load UI settings from the public endpoint. Called once on app init. */
  loadSettings(): Observable<UISettings> {
    return this.http.get<UISettings>(`${environment.apiUrl}/settings/ui`).pipe(
      tap(settings => {
        this.settingsSubject.next(settings);
        this.loaded = true;
        this.applyBrowserBranding(settings);
      }),
      catchError(err => {
        console.warn('Failed to load UI settings, using defaults:', err);
        this.settingsSubject.next(DEFAULT_SETTINGS);
        this.loaded = true;
        return of(DEFAULT_SETTINGS);
      })
    );
  }

  /** Apply browser tab title and favicon from settings. */
  private applyBrowserBranding(settings: UISettings): void {
    // Update browser tab title
    if (settings.app_title) {
      document.title = settings.app_title;
    }

    // Update favicon if a custom one is set
    if (settings.favicon_image) {
      let link: HTMLLinkElement | null = document.querySelector("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = settings.favicon_image;
    }
  }

  /** Get current settings synchronously. */
  get currentSettings(): UISettings {
    return this.settingsSubject.value;
  }

  /** Admin: Get UI settings via admin endpoint. */
  getSettingsAdmin(): Observable<UISettings> {
    return this.http.get<UISettings>(`${environment.apiUrl}/admin/settings/ui`);
  }

  /** Admin: Update UI settings. */
  updateSettings(settings: UISettings): Observable<UISettings> {
    return this.http.put<UISettings>(`${environment.apiUrl}/admin/settings/ui`, settings).pipe(
      tap(saved => {
        this.settingsSubject.next(saved);
        this.applyBrowserBranding(saved);
      })
    );
  }
}
