/**
 * CR-16 — Log out control for the application header. AuthGate provides the session only when authentication is
 * enabled AND this browser is signed in; otherwise there is no provider and nothing is rendered (auth disabled →
 * hidden). Sign-out never touches browser storage, so trading data is untouched.
 */
import { createContext, useContext } from 'react';

export interface AuthSession {
  user: string;
  signingOut: boolean;
  /** Set when sign-out could not be confirmed and this browser is still signed in. */
  error: string | null;
  logout: () => void;
}

export const AuthSessionContext = createContext<AuthSession | null>(null);

export function LogoutButton() {
  const s = useContext(AuthSessionContext);
  if (!s) return null;
  return (
    <span className="flex items-center gap-2">
      {s.error && <span role="alert" className="max-w-[260px] text-[11px] leading-tight text-rose-300">{s.error}</span>}
      <span className="hidden text-[11px] text-ink-400 md:inline">Signed in as <span className="font-semibold text-ink-200">{s.user}</span></span>
      <button type="button" onClick={s.logout} disabled={s.signingOut} title="Sign out (your Journal and settings stay in this browser)"
        className="rounded-full border border-ink-500 bg-ink-800 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-100 hover:border-ink-400 hover:bg-ink-700 disabled:opacity-50">
        {s.signingOut ? 'Signing out…' : 'Log out'}
      </button>
    </span>
  );
}
