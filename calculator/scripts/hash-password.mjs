#!/usr/bin/env node
/**
 * CR-16 — produce the RB_AUTH_PASSWORD_HASH value (scrypt). The password is read from stdin (hidden when typed at a
 * terminal) and is never written to disk, logged or passed on the command line.
 *
 *   node scripts/hash-password.mjs            # prompts twice, prints only the hash
 *
 * Paste the printed line into Netlify → Site configuration → Environment variables → RB_AUTH_PASSWORD_HASH
 * (mark it secret, scope Functions). Same format as netlify/lib/session.ts hashPassword().
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';

const N = 16384, r = 8, p = 1, KEYLEN = 32;

function readHidden(prompt) {
  return new Promise((resolve) => {
    stderr.write(prompt);
    let buf = '';
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const pw = await readHidden('New RB Trade Decider password: ');
if (pw.length < 12) {
  stderr.write('Refused: use at least 12 characters.\n');
  process.exit(1);
}
if (stdin.isTTY) {
  const again = await readHidden('Repeat password: ');
  if (again !== pw) {
    stderr.write('Refused: the two entries differ.\n');
    process.exit(1);
  }
}
const salt = randomBytes(16);
const key = scryptSync(pw, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}\n`);
