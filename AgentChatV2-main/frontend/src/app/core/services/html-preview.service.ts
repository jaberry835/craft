import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * Holds HTML preview panel state so it survives Angular component
 * destruction/recreation during route transitions (e.g. new session navigation).
 */
@Injectable({ providedIn: 'root' })
export class HtmlPreviewService {
  private readonly _html$ = new BehaviorSubject<string>('');
  private readonly _open$ = new BehaviorSubject<boolean>(false);
  private sourceAgentId?: string;
  private sourceAgentName?: string;
  private preserveOnNextRouteChange = false;

  readonly html$ = this._html$.asObservable();
  readonly open$ = this._open$.asObservable();

  get html(): string { return this._html$.value; }
  get isOpen(): boolean { return this._open$.value; }
  get previewContext(): { sourceAgentId?: string; sourceAgentName?: string; currentHtml?: string } {
    return {
      sourceAgentId: this.sourceAgentId,
      sourceAgentName: this.sourceAgentName,
      currentHtml: this._html$.value || undefined,
    };
  }

  show(html: string, sourceAgentId?: string, sourceAgentName?: string): void {
    const sameHtml = this._html$.value === html;
    this._html$.next(html);

    // Preserve the original source agent when duplicate preview events for the
    // same HTML arrive later from synthesized/fallback paths.
    if (!sameHtml || !this.sourceAgentId) {
      this.sourceAgentId = sourceAgentId;
      this.sourceAgentName = sourceAgentName;
    }

    this._open$.next(true);
  }

  close(): void {
    this._open$.next(false);
  }

  preserveForNextRouteChange(): void {
    this.preserveOnNextRouteChange = true;
  }

  consumeRoutePreservation(): boolean {
    const preserve = this.preserveOnNextRouteChange;
    this.preserveOnNextRouteChange = false;
    return preserve;
  }

  clear(): void {
    this._html$.next('');
    this.sourceAgentId = undefined;
    this.sourceAgentName = undefined;
    this.preserveOnNextRouteChange = false;
    this._open$.next(false);
  }
}
