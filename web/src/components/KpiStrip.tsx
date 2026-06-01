import type { DashboardRow } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const hours = (n: number) => `${Math.round(n).toLocaleString('en-US')}h`;

/** Four headline metrics, aggregated client-side from /api/dashboard. */
export function KpiStrip({ rows }: { rows: DashboardRow[] }) {
  const activeProjects = rows.length;
  const actual = rows.reduce((s, r) => s + Number(r.actual_hours), 0);
  const planned = rows.reduce((s, r) => s + Number(r.planned_hours), 0);
  const recognized = rows.reduce((s, r) => s + Number(r.recognized_month), 0);
  const gap = rows.reduce((s, r) => s + Math.max(0, Number(r.gap_month)), 0);

  return (
    <div className="kpi-strip">
      <div className="kpi-card">
        <div className="label">Active projects</div>
        <div className="value">{activeProjects}</div>
        <div className="hint">in execution</div>
      </div>
      <div className="kpi-card">
        <div className="label">Hours actual / budget</div>
        <div className="value">{hours(actual)}</div>
        <div className="hint">of {hours(planned)} budgeted</div>
      </div>
      <div className="kpi-card">
        <div className="label">Recognized this month</div>
        <div className="value">{money(recognized)}</div>
        <div className="hint">% completion basis</div>
      </div>
      <div className="kpi-card">
        <div className="label">Uninvoiced gap</div>
        <div className="value">{money(gap)}</div>
        <div className="hint">recognized − invoiced</div>
      </div>
    </div>
  );
}
