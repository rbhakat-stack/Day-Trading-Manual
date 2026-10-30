/**
 * Alert storage. Production uses Netlify Blobs (strong consistency); tests use the in-memory store.
 * Keys: alerts/<ET date>/<id>  and  dedupe/<sha256 of the dedupe key>.
 */
import { createHash } from 'node:crypto';
import type { AutoAlertRecord } from '../../src/engine/automation/alertDecision';

export interface AlertStore {
  getDedupe(key: string): Promise<string | null>;
  setDedupe(key: string, id: string): Promise<void>;
  get(date: string, id: string): Promise<AutoAlertRecord | null>;
  put(date: string, rec: AutoAlertRecord): Promise<void>;
  list(date: string): Promise<AutoAlertRecord[]>;
}

export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');

export class MemoryStore implements AlertStore {
  dedupe = new Map<string, string>();
  recs = new Map<string, AutoAlertRecord>();
  async getDedupe(key: string) {
    return this.dedupe.get(hashKey(key)) ?? null;
  }
  async setDedupe(key: string, id: string) {
    this.dedupe.set(hashKey(key), id);
  }
  async get(date: string, id: string) {
    const r = this.recs.get(`${date}/${id}`);
    return r ? structuredClone(r) : null;
  }
  async put(date: string, rec: AutoAlertRecord) {
    this.recs.set(`${date}/${rec.id}`, structuredClone(rec));
  }
  async list(date: string) {
    return [...this.recs.entries()].filter(([k]) => k.startsWith(`${date}/`)).map(([, v]) => structuredClone(v));
  }
}

/** Netlify Blobs implementation (imported lazily so unit tests never need the Netlify runtime). */
export async function blobStore(): Promise<AlertStore> {
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name: 'rb-v1-alerts', consistency: 'strong' });
  return {
    async getDedupe(key) {
      return ((await s.get(`dedupe/${hashKey(key)}`, { type: 'text' })) as string | null) ?? null;
    },
    async setDedupe(key, id) {
      await s.set(`dedupe/${hashKey(key)}`, id);
    },
    async get(date, id) {
      return ((await s.get(`alerts/${date}/${id}`, { type: 'json' })) as AutoAlertRecord | null) ?? null;
    },
    async put(date, rec) {
      await s.setJSON(`alerts/${date}/${rec.id}`, rec);
    },
    async list(date) {
      const { blobs } = await s.list({ prefix: `alerts/${date}/` });
      const out = await Promise.all(blobs.map((b) => s.get(b.key, { type: 'json' }) as Promise<AutoAlertRecord | null>));
      return out.filter((x): x is AutoAlertRecord => !!x);
    },
  };
}
