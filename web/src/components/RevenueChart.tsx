import type { RevenueRow } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const monthLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

/** Recognized vs. invoiced bars per month (plain divs, no chart lib). */
export function RevenueChart({ rows }: { rows: RevenueRow[] }) {
  if (rows.length === 0) return <div className="empty">No revenue data yet.</div>;

  const max = Math.max(
    1,
    ...rows.map((r) => Math.max(Number(r.recognized_amount), Number(r.invoiced_amount)))
  );
  const h = (v: number) => `${Math.round((Number(v) / max) * 150)}px`;

  return (
    <div className="card">
      <div className="legend">
        <span><span className="sw" style={{ background: 'var(--accent)' }} />Recognized</span>
        <span><span className="sw" style={{ background: 'var(--green)' }} />Invoiced</span>
      </div>
      <div className="revchart">
        {rows.map((r) => (
          <div className="revbar" key={r.period_month}>
            <div className="bars">
              <span
                className="rec"
                style={{ height: h(r.recognized_amount) }}
                title={`Recognized ${money(Number(r.recognized_amount))}`}
              />
              <span
                className="inv"
                style={{ height: h(r.invoiced_amount) }}
                title={`Invoiced ${money(Number(r.invoiced_amount))}`}
              />
            </div>
            <div className="month">{monthLabel(r.period_month)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
