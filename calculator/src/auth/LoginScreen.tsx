/** CR-16 — standalone sign-in screen. The password is sent once over HTTPS to rb-auth and never stored in the browser. */
import { useState, type FormEvent } from 'react';
import { login } from './authClient';

export function LoginScreen({ onSignedIn, notice = null }: { onSignedIn: () => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password || busy) return;
    setBusy(true);
    setError(null);
    const r = await login(username, password);
    setPassword('');
    setBusy(false);
    if (r.ok) onSignedIn();
    else setError(r.error);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-6" aria-label="Sign in">
        <h1 className="text-base font-bold text-ink-100">RB Trade Decider</h1>
        <p className="mt-1 text-xs text-ink-400">Sign in to continue.</p>
        {notice && <p role="status" className="mt-3 rounded-md border border-warn/40 px-2.5 py-2 text-xs text-warn">{notice}</p>}
        <label className="mt-5 block text-xs font-semibold text-ink-300" htmlFor="rb-auth-user">Username</label>
        <input id="rb-auth-user" name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
          className="mt-1 w-full rounded-md border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none focus:border-ink-400" />
        <label className="mt-3 block text-xs font-semibold text-ink-300" htmlFor="rb-auth-pass">Password</label>
        <input id="rb-auth-pass" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none focus:border-ink-400" />
        {error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}
        <button type="submit" disabled={busy || !username || !password}
          className="mt-5 w-full rounded-md bg-ink-100 px-3 py-2 text-sm font-semibold text-ink-900 hover:bg-white disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
