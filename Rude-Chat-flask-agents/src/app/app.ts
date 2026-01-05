import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from './services/auth.service';
import { ChatComponent } from './components/chat.component';
import { LoginComponent } from './components/login.component';
import { MsalService } from '@azure/msal-angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ChatComponent, LoginComponent],
  template: `
    <!-- Show chat if logged in, otherwise show login -->
    <ng-container *ngIf="authService.isLoggedIn$ | async; else login">
      <app-chat></app-chat>
    </ng-container>
    <ng-template #login>
      <app-login></app-login>
    </ng-template>
  `,
  styleUrls: ['./app.scss']
})
export class App implements OnInit {
  authService = inject(AuthService);
  private msalService = inject(MsalService);

  async ngOnInit(): Promise<void> {
    console.log('App initialized - handling MSAL initialization and redirect');
    
    try {
      // Initialize MSAL instance
      await this.msalService.instance.initialize();
      console.log('MSAL instance initialized successfully');
      
      // Handle redirect promise
      const result = await this.msalService.instance.handleRedirectPromise();
      console.log('Redirect promise handled:', result);
      
      if (result) {
        console.log('Login successful from redirect:', result.account);
      }
    } catch (error) {
      console.error('Error during MSAL initialization/redirect handling:', error);
    }
    
    // Update auth state after initialization
    this.authService.updateAuthState();
    
     // Subscribe to authentication state changes
    this.authService.isLoggedIn$.subscribe(isLoggedIn => {
      console.log('Authentication state changed:', isLoggedIn);
    });
  }
}
