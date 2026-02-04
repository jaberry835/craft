import { Routes } from '@angular/router';
import { MsalGuard } from '@azure/msal-angular';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/chat/chat.component').then(m => m.ChatComponent),
    canActivate: [MsalGuard]
  },
  {
    path: 'chat/:sessionId',
    loadComponent: () => import('./features/chat/chat.component').then(m => m.ChatComponent),
    canActivate: [MsalGuard]
  },
  {
    path: 'admin',
    loadComponent: () => import('./features/admin/admin.component').then(m => m.AdminComponent),
    canActivate: [MsalGuard, adminGuard]  // Requires both authentication and admin role
  },
  {
    path: '**',
    redirectTo: ''
  }
];
