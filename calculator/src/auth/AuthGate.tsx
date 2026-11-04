/**
 * CR-16 — login guard around the unchanged application. The server decides (RB_AUTH_ENABLED); there is no client-side
 * or URL bypass. While the answer is unknown, or sign-in is required, the application is not rendered at all.
 * Signing out ends the server session only — Journal, candidates, snapshots, CR-15 backups and notes stay in this
 * browser untouched.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchAuthStatus, logout, nextState, type AuthState } from './authClient';
import { LoginScreen } from './LoginScreen';

const RECHECK_MS = 60_000;

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'checking' });
  const refresh = useCallback(async () => {
    const fresh = await fetchAuthStatus();
    setState((cur) => nextState(cur, fresh));
  }, []);

  useEffect(() => {
    void refresh();
    const h = setInterval(() => void refresh(), RECHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Absolute session expiry: re-check the moment it passes.
  const expiresAt = state.kind === 'authenticated' ? state.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    const h = setTimeout(() => void refresh(), Math.max(0, Math.min(ms + 1000, 2_147_000_000)));
    return () => clearTimeout(h);
  }, [expiresAt, refresh]);

  const [signingOut, setSigningOut] = useState(false);
  const onLogout = async () => {
    setSigningOut(true);
    await logout();
    setSigningOut(false);
    setState({ kind: 'checking' });
    await refresh();
  };

  if (state.kind === 'disabled') return <>{children}</>;
  if (state.kind === 'authenticated') {
    return (
      <>
        {children}
        <div className="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/95 px-3 py-1.5 text-xs text-ink-300 shadow-lg backdrop-blur">
          <span className="hidden sm:inline">Signed in as <span className="font-semibold text-ink-100">{state.user}</span></span>
          <button type="button" onClick={() => void onLogout()} disabled={signingOut} className="rounded-full border border-ink-600 px-2.5 py-0.5 font-semibold text-ink-100 hover:bg-ink-800 disabled:opacity-50">
            {signingOut ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      </>
    );
  }
  if (state.kind === 'login') return <LoginScreen onSignedIn={() => void refresh()} />;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-6 text-center">
        <h1 className="text-base font-bold text-ink-100">RB Trade Decider</h1>
        {state.kind === 'checking' && <p className="mt-3 text-sm text-ink-400">Checking sign-in…</p>}
        {state.kind === 'misconfigured' && <p className="mt-3 text-sm text-rose-300">Sign-in is required but is not configured on the server. Access is refused.</p>}
        {state.kind === 'unreachable' && (
          <>
            <p className="mt-3 text-sm text-rose-300">Sign-in status could not be verified, so the application is not shown.</p>
            <p className="mt-1 text-xs text-ink-500">{state.error}</p>
          </>
        )}
        {state.kind !== 'checking' && (
          <button type="button" onClick={() => { setState({ kind: 'checking' }); void refresh(); }} className="mt-4 rounded-md border border-ink-600 px-3 py-1.5 text-sm font-semibold text-ink-100 hover:bg-ink-800">
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
