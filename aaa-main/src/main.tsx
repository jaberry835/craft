import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthGate } from './authGate';
import './index.css';
import './copilotTheme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>{(user) => <App user={user} />}</AuthGate>
  </StrictMode>
);
