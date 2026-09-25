import { useEffect, useState, type ReactNode } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { authEnabled, initializeAuth, refreshBrowserSession, signIn } from './auth';

export interface SignedInUser {
  displayName: string;
  username?: string;
}

type GateState =
  | { status: 'loading' }
  | { status: 'sign-in'; message?: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; user?: SignedInUser };

const sessionRefreshMs = 30 * 60_000;

/**
 * Shows the app directly when sign-in is off. When Microsoft Entra sign-in is on, shows a
 * sign-in screen until the user has an account, then keeps the browser session fresh.
 */
export function AuthGate({ children }: { children: (user?: SignedInUser) => ReactNode }) {
  const [state, setState] = useState<GateState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const auth = await initializeAuth();
        if (cancelled) return;
        if (auth.mode === 'none') {
          setState({ status: 'ready' });
          return;
        }
        if (!auth.account) {
          setState({ status: 'sign-in' });
          return;
        }
        await refreshBrowserSession();
        if (!cancelled) {
          setState({ status: 'ready', user: { displayName: auth.account.name || auth.account.username, username: auth.account.username } });
        }
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : 'Sign-in could not be completed.' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || !authEnabled()) return;
    const timer = window.setInterval(() => {
      void refreshBrowserSession().catch((error: unknown) => {
        console.error(`[aaa] Could not refresh the sign-in session: ${error instanceof Error ? error.message : error}`);
      });
    }, sessionRefreshMs);
    const onRequired = () => setState({ status: 'sign-in', message: 'Your sign-in expired. Sign in again to continue.' });
    window.addEventListener('aaa:auth-required', onRequired);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('aaa:auth-required', onRequired);
    };
  }, [state.status]);

  if (state.status === 'ready') return <>{children(state.user)}</>;
  return (
    <main className="auth-screen">
      <section>
        <ShieldCheck size={28} />
        <h1>AAA · A&amp;A Accelerator</h1>
        {state.status === 'loading' && <p>Checking sign-in…</p>}
        {state.status === 'sign-in' && (
          <>
            <p>{state.message ?? 'Sign in with your Microsoft Entra account to open the workbench.'}</p>
            <button className="dialog-primary" onClick={() => void signIn()}><LogIn size={15} /> Sign in with Microsoft</button>
          </>
        )}
        {state.status === 'error' && (
          <>
            <p className="auth-error">{state.message}</p>
            <button className="dialog-primary" onClick={() => window.location.reload()}>Try again</button>
          </>
        )}
      </section>
    </main>
  );
}
