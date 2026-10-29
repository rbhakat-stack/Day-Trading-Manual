/** localStorage helpers. Storage can be unavailable (private mode, blocked); never throw. */

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function download(filename: string, content: string, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const KEYS = {
  settings: 'rbv1.settings.v1',
  journal: 'rbv1.journal.v1',
  candidates: 'rbv1.ranker.candidates.v1',
  positions: 'rbv1.ranker.positions.v1',
  rankerSettings: 'rbv1.ranker.settings.v1',
  strategyVersion: 'rbv1.strategy.version.v1',
} as const;
