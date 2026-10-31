import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CR-012 — secret hygiene before the webhook-secret rotation. Failures report FILE PATHS only, never a value.
 *   • tracked files contain no non-synthetic webhook token literal
 *   • frontend source never references server secrets
 *   • the production bundle (if built) contains no server secret names
 *   • when a local .env exists, none of its secret VALUES appears in a tracked file or the bundle
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET_NAMES = ['TRENDSPIDER_WEBHOOK_SECRET', 'RB_APP_ACCESS_TOKEN', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'];
/** Server-only secrets the browser must never know about (RB_APP_ACCESS_TOKEN is typed by the user into the app, so its NAME appears in the UI). */
const SERVER_ONLY = ['TRENDSPIDER_WEBHOOK_SECRET', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY'];
const TEXT = /\.(ts|tsx|mts|js|mjs|json|md|html|css|csv|toml|txt|yml|yaml)$/i;

function tracked(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && TEXT.test(f));
  } catch {
    return [];
  }
}
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

/** Webhook token values allowed in tracked files: placeholders and obviously synthetic test values. */
const SYNTHETIC = /^(<[^>]+>|whsec|wrong|apptok|s3cret|AKTEST|SKTEST|rbv1\.[a-z0-9.]+|.*(synthetic|test|fake|dummy|example|placeholder|redacted).*)$/i;

describe('secret hygiene (paths only, values never printed)', () => {
  const files = tracked();
  it('(9) no tracked file carries a non-synthetic "token" value', () => {
    expect(files.length).toBeGreaterThan(50);
    const bad: string[] = [];
    const re = /["']?(token|secret)["']?\s*:\s*["']([^"'\s]{4,})["']/gi;
    for (const f of files) {
      for (const m of read(f).matchAll(re)) if (!SYNTHETIC.test(m[2]) && !/^\$\{|^process\.env|^env\(/.test(m[2])) bad.push(`${f} (${m[1]})`);
    }
    expect(bad).toEqual([]);
  });
  it('(9) frontend source never references server-only secrets', () => {
    const bad = files.filter((f) => f.startsWith('src/') && !f.includes('__tests__') && SERVER_ONLY.some((n) => read(f).includes(n)));
    expect(bad).toEqual([]);
  });
  it('(9) the production bundle contains no server-only secret names (skipped when not built)', () => {
    const bundle = walk(join(ROOT, 'dist')).filter((f) => TEXT.test(f));
    const bad = bundle.filter((f) => SERVER_ONLY.some((n) => readFileSync(f, 'utf8').includes(n)));
    expect(bad).toEqual([]);
  });
  it('(9) local .env secret values (if present) appear in no tracked file and not in the bundle', () => {
    const envFile = join(ROOT, '.env');
    if (!existsSync(envFile)) return;
    const values = readFileSync(envFile, 'utf8').split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && SECRET_NAMES.includes(m[1]))
      .map((m) => m[2].trim().replace(/^["']|["']$/g, ''))
      .filter((v) => v.length >= 8);
    const targets = [...files.map((f) => resolve(ROOT, f)), ...walk(join(ROOT, 'dist')).filter((f) => TEXT.test(f))];
    const bad = targets.filter((f) => { const t = readFileSync(f, 'utf8'); return values.some((v) => t.includes(v)); }).map((f) => f.slice(ROOT.length + 1));
    expect(bad).toEqual([]);
  });
});
