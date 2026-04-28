import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, catchError, of } from 'rxjs';
import { environment } from '@env/environment';

export interface UserPreferences {
  theme: 'dark' | 'light';
}

const DEFAULT_PREFS: UserPreferences = {
  theme: 'dark'
};

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private apiUrl = `${environment.apiUrl}/user/preferences`;
  private prefsSubject = new BehaviorSubject<UserPreferences>(DEFAULT_PREFS);
  public preferences$ = this.prefsSubject.asObservable();

  constructor(private http: HttpClient) {}

  /** Load user preferences from the API. Called after auth is ready. */
  loadPreferences(): Observable<UserPreferences> {
    return this.http.get<UserPreferences>(this.apiUrl).pipe(
      tap(prefs => {
        const merged = { ...DEFAULT_PREFS, ...prefs };
        this.prefsSubject.next(merged);
        this.applyTheme(merged.theme);
      }),
      catchError(err => {
        console.warn('Failed to load user preferences, using defaults:', err);
        this.applyTheme(DEFAULT_PREFS.theme);
        return of(DEFAULT_PREFS);
      })
    );
  }

  /** Save user preferences to the API. */
  updatePreferences(prefs: Partial<UserPreferences>): Observable<UserPreferences> {
    const current = this.prefsSubject.value;
    const updated = { ...current, ...prefs };
    return this.http.put<UserPreferences>(this.apiUrl, updated).pipe(
      tap(saved => {
        const merged = { ...DEFAULT_PREFS, ...saved };
        this.prefsSubject.next(merged);
        this.applyTheme(merged.theme);
      })
    );
  }

  /** Apply the theme by toggling a CSS class on <body>. */
  private applyTheme(theme: string): void {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
  }
}
