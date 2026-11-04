#!/usr/bin/env node
/**
 * CR-16 — produce the RB_AUTH_PASSWORD_HASH value (scrypt). The password is read from stdin (hidden when typed at a
 * terminal) and is never written to disk, logged or passed on the command line.
 *
 *   node scripts/hash-password.mjs            # prompts twice, prints only the hash
 *   node scripts/hash-password.mjs --verify   # hash in $env:RB_VERIFY_HASH; prompts once; prints MATCH / NO MATCH
 *
 * Paste the printed line into Netlify → Site configuration → Environment variables → RB_AUTH_PASSWORD_HASH
 * (mark it secret, scope Functions). Same format as netlify/lib/session.ts hashPassword().
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';

const N = 16384, r = 8, p = 1, KEYLEN = 32;

// Hidden line reader. Stays in raw mode for the whole run (no raw on/off between prompts) and keeps every keystroke
// in one queue, so on Windows consoles a CR LF pair (Enter, or a pasted password with a trailing newline) counts as ONE
// line end even when the LF arrives in a later chunk, and input typed ahead is never lost. Escape sequences (arrow /
// Home / End keys, bracketed-paste markers) and other control characters are ignored, never added to the password.
const lines = [];
let current = '', lastCR = false, escape = 0, waiting = null;
function onData(chunk) {
  for (const ch of chunk) {
    if (escape === 1) { escape = ch === '[' || ch === 'O' ? 2 : 0; continue; } // ESC [ … or ESC O …
    if (escape === 2) { if (ch >= '@' && ch <= '~') escape = 0; continue; } // … up to the final byte
    if (ch === '\u001b') { escape = 1; continue; }
    if (ch === '\u0003') { finish(); process.exit(130); } // Ctrl+C
    if (ch === '\n' && lastCR) { lastCR = false; continue; } // LF of a CR LF pair
    lastCR = ch === '\r';
    if (ch === '\r' || ch === '\n') { if (current) lines.push(current); current = ''; continue; } // blank Enter (e.g. after a paste that already ended the line) is ignored
    if (ch === '\u007f' || ch === '\b') { current = current.slice(0, -1); continue; }
    if (ch < ' ') continue;
    current += ch;
  }
  if (waiting && lines.length) { const w = waiting; waiting = null; w(lines.shift()); }
}
function finish() {
  stdin.off('data', onData);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
}
if (stdin.isTTY) stdin.setRawMode(true);
stdin.setEncoding('utf8');
stdin.on('data', onData);
stdin.on('end', () => { if (waiting) { lines.push(current); current = ''; onData(''); } }); // piped input: the last line (possibly empty → refused as too short)
stdin.resume();

function readHidden(prompt) {
  stderr.write(prompt);
  return new Promise((resolve) => {
    waiting = (line) => { stderr.write('\n'); resolve(line); };
    onData('');
  });
}

if (process.argv[2] === '--verify') {
  // Check a hash WITHOUT showing it: RB_VERIFY_HASH holds the hash, the password is typed hidden. Prints MATCH / NO MATCH.
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec((process.env.RB_VERIFY_HASH ?? '').trim());
  if (!m) { finish(); stderr.write('Refused: RB_VERIFY_HASH is missing or is not a valid scrypt hash.\n'); process.exit(1); }
  const typed = await readHidden('Password to check: ');
  finish();
  const key = Buffer.from(m[5], 'base64');
  const k2 = scryptSync(typed, Buffer.from(m[4], 'base64'), key.length, { N: +m[1], r: +m[2], p: +m[3], maxmem: 64 * 1024 * 1024 });
  stdout.write(timingSafeEqual(key, k2) ? 'MATCH\n' : 'NO MATCH\n');
  process.exit(0);
}

const pw = await readHidden('New RB Trade Decider password: ');
if (pw.length < 12) {
  finish();
  stderr.write('Refused: use at least 12 characters.\n');
  process.exit(1);
}
if (stdin.isTTY) {
  const again = await readHidden('Repeat password: ');
  if (again !== pw) {
    finish();
    stderr.write('Refused: the two entries differ.\n');
    process.exit(1);
  }
}
finish();
const salt = randomBytes(16);
const key = scryptSync(pw, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}\n`);
