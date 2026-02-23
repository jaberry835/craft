import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { SettingsService, UISettings } from '../../../core/services/settings.service';

@Component({
  selector: 'app-classification-banner',
  standalone: true,
  imports: [],
  template: `
    @if (enabled) {
      <div 
        class="classification-banner"
        [style.backgroundColor]="backgroundColor"
        [style.color]="foregroundColor"
      >
        {{ bannerText }}
      </div>
    }
  `,
  styles: [`
    .classification-banner {
      width: 100%;
      text-align: center;
      padding: 4px 16px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      z-index: 9999;
      flex-shrink: 0;
      user-select: none;
    }
  `]
})
export class ClassificationBannerComponent implements OnInit, OnDestroy {
  enabled = false;
  bannerText = 'UNCLASSIFIED';
  backgroundColor = '#007a33';
  foregroundColor = '#ffffff';

  private destroy$ = new Subject<void>();

  constructor(private settingsService: SettingsService) {}

  ngOnInit(): void {
    this.settingsService.settings$
      .pipe(takeUntil(this.destroy$))
      .subscribe(settings => {
        const banner = settings.classification_banner;
        this.enabled = banner.enabled;
        this.bannerText = banner.text || 'UNCLASSIFIED';
        this.backgroundColor = banner.background_color || '#007a33';
        this.foregroundColor = banner.foreground_color || '#ffffff';
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
