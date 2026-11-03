import type { PortfolioVerification } from '../engine/automation/lifecycle/portfolioExposure';

/** Portfolio verification warning (Live Alert Queue and Opportunity Ranker). Nothing is shown when verified. */
export function PortfolioVerificationBanner({ v }: { v: PortfolioVerification | null | undefined }) {
  if (!v || v.verified) return null;
  const off = v.state === 'OFF';
  return (
    <p role="status" data-section="portfolio-verification" data-state={v.state}
      className={`rounded-lg border px-4 py-2 text-[13px] font-semibold ${off ? 'border-ink-500 bg-ink-850 text-ink-200' : 'border-short bg-short-dim/30 text-[#ffc0c8]'}`}>
      {v.message}
    </p>
  );
}
