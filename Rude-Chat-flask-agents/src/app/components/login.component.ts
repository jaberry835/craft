import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatButtonModule, MatIconModule],
  template: `
    <div class="login-container">
      <mat-card class="login-card">
        <mat-card-header>
          <div class="login-header">
            <mat-icon class="app-icon">smart_toy</mat-icon>
            <h1>Rude Chat</h1>
            <p>Your AI-powered chat assistant with Azure integrations</p>
          </div>
        </mat-card-header>
        
        <mat-card-content class="login-content">
          <div class="features-list">
            <div class="feature">
              <mat-icon>chat</mat-icon>
              <span>ChatGPT-style conversations</span>
            </div>
            <div class="feature">
              <mat-icon>cloud</mat-icon>
              <span>Azure OpenAI integration</span>
            </div>
            <div class="feature">
              <mat-icon>search</mat-icon>
              <span>RAG with your documents</span>
            </div>
            <div class="feature">
              <mat-icon>build</mat-icon>
              <span>Advanced tooling via MCP</span>
            </div>
          </div>
        </mat-card-content>
        
        <mat-card-actions class="login-actions">          <button 
            mat-raised-button 
            color="primary" 
            (click)="handleLogin()"
            class="login-button">
            <mat-icon>login</mat-icon>
            Sign in with Microsoft
          </button>
          
          <!-- Debug button 
          <button 
            mat-button 
            (click)="checkAuthStatus()"
            style="margin-top: 10px;">
            Check Auth Status
          </button>-->
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  authService = inject(AuthService);

  async handleLogin() {
    console.log('Login button clicked in component');
    try {
      await this.authService.login();
    } catch (error) {
      console.error('Error in handleLogin:', error);
    }
  }  checkAuthStatus() {
    console.log('=== DEBUG AUTH STATUS ===');
    console.log('Current URL:', window.location.href);
    console.log('URL has code param:', window.location.href.includes('code='));
    console.log('URL has error param:', window.location.href.includes('error='));
    
    const accounts = this.authService.getUser();
    console.log('Current user account:', accounts);
    
    // Check MSAL configuration
    console.log('MSAL Configuration:');
    console.log('- Client ID:', (this.authService as any).msalService.instance.getConfiguration().auth.clientId);
    console.log('- Authority:', (this.authService as any).msalService.instance.getConfiguration().auth.authority);
    console.log('- Redirect URI:', (this.authService as any).msalService.instance.getConfiguration().auth.redirectUri);
    
    // Check localStorage for MSAL data
    console.log('LocalStorage MSAL keys:');
    Object.keys(localStorage).filter(key => key.includes('msal')).forEach(key => {
      console.log(`- ${key}:`, localStorage.getItem(key));
    });
    
    // Force update auth state
    console.log('Forcing auth state update...');
    this.authService.updateAuthState();
  }
}
