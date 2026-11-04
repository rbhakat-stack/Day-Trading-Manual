/**
 * CR-16 — login guard around the unchanged application. The server decides (RB_AUTH_ENABLED); there is no client-side
 * or URL bypass. While the answer is unknown, or sign-in is required, the application is not rendered at all.
 * Signing out ends the server session only — Journal, candidates, snapshots, CR-15 backups and notes stay in this
 * browser untouched.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchAuthStatus, nextState, performLogout, type AuthState } from './authClient';
import { LoginScreen } from './LoginScreen';
import { AuthSessionContext } from './LogoutButton';

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
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onLogout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError(null);
    const r = await performLogout();
    setSigningOut(false);
    if (r.kind === 'failed') {
      setLogoutError(r.message); // still signed in: stay in the app and say so
      return;
    }
    setNotice(r.kind === 'unconfirmed' ? r.message : null);
    setState(r.state);
  };

  if (state.kind === 'disabled') return <>{children}</>;
  if (state.kind === 'authenticated') {
    // The Log out control is rendered in the application header (LogoutButton) from this context.
    return (
      <AuthSessionContext.Provider value={{ user: state.user, signingOut, error: logoutError, logout: () => void onLogout() }}>
        {children}
      </AuthSessionContext.Provider>
    );
  }
  if (state.kind === 'login') return <LoginScreen notice={notice} onSignedIn={() => { setNotice(null); setLogoutError(null); void refresh(); }} />;
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
