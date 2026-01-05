import { Injectable, inject } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable, from, switchMap } from 'rxjs';
import { AuthService } from '../services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private authService = inject(AuthService);

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only add auth headers for API calls to our backend
    if (!req.url.includes('/api/')) {
      return next.handle(req);
    }

    return from(this.addAuthHeaders(req)).pipe(
      switchMap(authReq => next.handle(authReq))
    );
  }

  private async addAuthHeaders(req: HttpRequest<any>): Promise<HttpRequest<any>> {
    try {
      // Get general access token
      const accessToken = await this.authService.getAccessToken();
      
      let headers = req.headers;

      // Add general authorization header
      if (accessToken) {
        headers = headers.set('Authorization', `Bearer ${accessToken}`);
      }

      // Only add ADX token for endpoints that specifically need it
      // Check if this is an ADX-related request or a request that might use tools
      const needsADXToken = req.url.includes('/adx') || 
                           req.url.includes('/agents') || 
                           req.url.includes('/chat') ||
                           req.body && JSON.stringify(req.body).toLowerCase().includes('adx');      // console.log(`🔍 Auth Interceptor - URL: ${req.url}, needsADXToken: ${needsADXToken}`);
      
      if (needsADXToken) {
        // console.log(`🔄 Requesting ADX token for URL: ${req.url}`);
        const adxToken = await this.authService.getADXAccessToken();
        // console.log(`🔑 ADX Token acquired: ${adxToken ? 'YES' : 'NO'}`);
        if (adxToken) {
          // console.log(`🔑 ADX Token details: ${adxToken.substring(0, 20)}...`);
          headers = headers.set('X-ADX-Token', adxToken);
          // console.log(`✅ X-ADX-Token header added to request`);
        } else {
           console.log(`❌ No ADX token available - header not added`);
           console.log(`💡 If you need ADX access, run: window.authService.forceADXConsent()`);
        }
      }

      // Add user ID for session tracking
      const userId = this.authService.getUserId();
      if (userId) {
        headers = headers.set('X-User-ID', userId);
      }

      return req.clone({ headers });
    } catch (error) {
      console.error('Error adding auth headers:', error);
      return req;
    }
  }
}
