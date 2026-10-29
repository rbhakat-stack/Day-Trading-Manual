import { useEffect, useState } from 'react';
import { FROZEN_VERSION } from '../engine/strategyVersion';

/** A proposed change to the core strategy definition, waiting for the user's version decision. */
export interface PendingVersionChange {
  fields: string[];
  suggested: string;
}

export interface VersionControls {
  label: string;
  name: string;
  frozen: boolean;
  locked: boolean;
  pending: PendingVersionChange | null;
  setLocked: (locked: boolean) => void;
  confirmPending: (name: string) => void;
  cancelPending: () => void;
}

/** Version badge, freeze warning, unlock control and the "create a new version?" prompt. */
export function StrategyVersionBar({ v }: { v: VersionControls }) {
  const [name, setName] = useState(v.pending?.suggested ?? '');
  useEffect(() => setName(v.pending?.suggested ?? ''), [v.pending?.suggested]);
  return (
    <div className="space-y-3">
      <section className={`rounded-xl border p-4 text-sm ${v.frozen ? 'border-[#5b8cff]/50 bg-[#5b8cff]/10 text-ink-200' : 'border-warn/50 bg-warn-dim/30 text-[#ffe2a8]'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={`rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wider ${v.frozen ? 'bg-[#5b8cff]/20 text-[#a9c1ff]' : 'bg-warn-dim text-warn'}`} data-testid="strategy-version-label">
            {v.label}
          </span>
          <button
            type="button"
            onClick={() => v.setLocked(!v.locked)}
            className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:bg-ink-700"
          >
            {v.locked ? `🔒 Unlock ${v.name} Settings` : `🔓 Lock ${v.name} Settings`}
          </button>
        </div>
        <p className="mt-2">
          {v.frozen ? (
            <>
              <b>{FROZEN_VERSION} is currently frozen for paper testing.</b> Changing scoring weights, thresholds, time buckets, risk limits or capital policy
              will create a new strategy version and can make historical comparisons less meaningful.
            </>
          ) : (
            <>
              <b>{v.name} is a custom strategy version.</b> Candidates keep the version they were scored under; compare versions separately in History &amp; analytics.
            </>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-400">
          {v.locked
            ? 'Strategy-definition settings are read-only. Account equity, broker buying power, positions and candidate data stay editable.'
            : 'Unlocked: a change to a strategy-definition setting will ask you to create a new strategy version before it is applied.'}
        </p>
      </section>
      {v.pending && (
        <section role="alertdialog" aria-label="Create a new strategy version" className="rounded-xl border-2 border-warn bg-warn-dim/40 p-4 text-sm text-[#ffe2a8]">
          <b>This changes the {v.name} strategy definition. Create a new strategy version?</b>
          <p className="mt-1 text-xs">Changed: {v.pending.fields.join(', ')}. The change is NOT applied until you confirm. Historical candidates keep their original version and scores.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs">
              New version
              <input value={name} onChange={(e) => setName(e.target.value)} className="num w-28 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[13px] text-ink-100" />
            </label>
            <button
              type="button"
              disabled={!name.trim() || name.trim() === v.name}
              onClick={() => v.confirmPending(name.trim())}
              className="rounded-lg bg-warn px-3 py-1.5 text-xs font-bold text-ink-900 disabled:opacity-40"
            >
              Create {name.trim() || 'version'} and apply
            </button>
            <button type="button" onClick={v.cancelPending} className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:bg-ink-700">
              Cancel — keep {v.name}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
