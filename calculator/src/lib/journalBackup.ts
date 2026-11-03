/**
 * CR-15 Journal backup / restore (browser localStorage). The pre-CR-15 backup is IMMUTABLE: written once, read back
 * and verified byte-for-byte before any reconciliation may write the Journal; never overwritten afterwards. Restore puts
 * that exact Journal back (after saving the current Journal under its own key). Only these keys are touched:
 *   rbv1.journal.v1                      the Journal (unchanged format)
 *   rbv1.journal.backup.pre-cr15.v1      immutable pre-CR-15 backup
 *   rbv1.journal.backup.pre-restore.v1   the Journal as it was just before a restore
 * No key is ever removed and nothing else in localStorage is read or written.
 */
import type { JournalEntry } from '../engine/journal';

export const JOURNAL_KEY = 'rbv1.journal.v1';
export const PRE_CR15_BACKUP_KEY = 'rbv1.journal.backup.pre-cr15.v1';
export const PRE_RESTORE_KEY = 'rbv1.journal.backup.pre-restore.v1';

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface JournalBackup {
  schema: 'rb-journal-backup/1';
  reason: 'pre-cr15' | 'pre-restore';
  createdIso: string;
  sourceKey: typeof JOURNAL_KEY;
  count: number;
  /** The Journal JSON exactly as it was stored (string, so the restore is byte-for-byte). */
  journalJson: string;
}

/** A stored Journal is an array of rows that each carry the fields every build reads. */
export function validateJournal(x: unknown): string | null {
  if (!Array.isArray(x)) return 'Journal is not an array.';
  const ids = new Set<string>();
  for (const [k, e] of x.entries()) {
    if (!e || typeof e !== 'object') return `Row ${k + 1} is not an object.`;
    const r = e as Partial<JournalEntry>;
    if (typeof r.id !== 'string' || !r.id) return `Row ${k + 1} has no id.`;
    if (ids.has(r.id)) return `Duplicate id ${r.id}.`;
    ids.add(r.id);
    if (typeof r.ticker !== 'string' || (r.direction !== 'LONG' && r.direction !== 'SHORT') || typeof r.outcome !== 'string') return `Row ${r.id} is missing ticker / direction / outcome.`;
  }
  return null;
}

export function readBackup(store: KeyValueStore, key = PRE_CR15_BACKUP_KEY): JournalBackup | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const b = JSON.parse(raw) as JournalBackup;
    if (b.schema !== 'rb-journal-backup/1' || typeof b.journalJson !== 'string') return null;
    return b;
  } catch {
    return null;
  }
}

/**
 * Ensure the immutable pre-CR-15 backup exists and matches what it claims. Creates it from the CURRENT stored Journal
 * only if absent; an existing backup is never overwritten. Fails (ok:false) — and the caller must then not write the
 * Journal — when the Journal is invalid, the write fails, or the read-back differs.
 */
export function ensurePreCr15Backup(store: KeyValueStore, nowIso: string): { ok: true; created: boolean; backup: JournalBackup } | { ok: false; error: string } {
  try {
    const existing = readBackup(store);
    if (existing) {
      const err = validateJournal(JSON.parse(existing.journalJson));
      return err ? { ok: false, error: `Existing pre-CR-15 backup is unreadable: ${err}` } : { ok: true, created: false, backup: existing };
    }
    const journalJson = store.getItem(JOURNAL_KEY) ?? '[]';
    const parsed = JSON.parse(journalJson) as unknown;
    const err = validateJournal(parsed);
    if (err) return { ok: false, error: `Current Journal failed validation — no backup made, nothing changed: ${err}` };
    const backup: JournalBackup = { schema: 'rb-journal-backup/1', reason: 'pre-cr15', createdIso: nowIso, sourceKey: JOURNAL_KEY, count: (parsed as unknown[]).length, journalJson };
    const text = JSON.stringify(backup);
    store.setItem(PRE_CR15_BACKUP_KEY, text);
    const back = store.getItem(PRE_CR15_BACKUP_KEY);
    if (back !== text) return { ok: false, error: 'Backup read-back did not match — nothing changed.' };
    const rb = readBackup(store);
    if (!rb || rb.journalJson !== journalJson) return { ok: false, error: 'Backup verification failed — nothing changed.' };
    return { ok: true, created: true, backup };
  } catch (e) {
    return { ok: false, error: `Backup failed — nothing changed: ${(e as Error).message}` };
  }
}

/**
 * Restore the exact pre-CR-15 Journal. The current Journal is first saved under PRE_RESTORE_KEY (and verified); only
 * then is the Journal key replaced with the backup's original JSON. Returns the restored rows for the in-memory state.
 */
export function restorePreCr15(store: KeyValueStore, nowIso: string): { ok: true; journal: JournalEntry[] } | { ok: false; error: string } {
  try {
    const b = readBackup(store);
    if (!b) return { ok: false, error: 'No pre-CR-15 backup exists in this browser.' };
    const rows = JSON.parse(b.journalJson) as JournalEntry[];
    const err = validateJournal(rows);
    if (err) return { ok: false, error: `Backup is not a valid Journal: ${err}` };
    const cur = store.getItem(JOURNAL_KEY) ?? '[]';
    const pre: JournalBackup = { schema: 'rb-journal-backup/1', reason: 'pre-restore', createdIso: nowIso, sourceKey: JOURNAL_KEY, count: (() => { try { return (JSON.parse(cur) as unknown[]).length; } catch { return 0; } })(), journalJson: cur };
    const preText = JSON.stringify(pre);
    store.setItem(PRE_RESTORE_KEY, preText);
    if (store.getItem(PRE_RESTORE_KEY) !== preText) return { ok: false, error: 'Could not save the current Journal before restoring — nothing changed.' };
    store.setItem(JOURNAL_KEY, b.journalJson);
    if (store.getItem(JOURNAL_KEY) !== b.journalJson) return { ok: false, error: 'Restore write did not verify — the previous Journal is saved under the pre-restore key.' };
    return { ok: true, journal: rows };
  } catch (e) {
    return { ok: false, error: `Restore failed: ${(e as Error).message}` };
  }
}
