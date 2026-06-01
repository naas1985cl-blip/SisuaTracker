import type { DashboardRow } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** One row per project: name + deal_id, hours burn bar, recognized, gap, health. */
export function ProjectTable({
  rows,
  onSelect,
}: {
  rows: DashboardRow[];
  onSelect: (dealId: number, name: string) => void;
}) {
  if (rows.length === 0) return <div className="empty">No active projects.</div>;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Hours burn</th>
            <th className="right">Recognized</th>
            <th className="right">Gap</th>
            <th>Invoicing</th>
            <th>Health</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = Math.min(100, Number(r.hours_consumed_pct));
            const invStatus =
              Number(r.gap_month) <= 0 ? 'ok' : Number(r.invoiced_month) === 0 ? 'missing' : 'pending';
            return (
              <tr
                key={r.project_id}
                className="clickable"
                onClick={() => onSelect(r.deal_id, r.project_name)}
              >
                <td>
                  <div>{r.project_name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>deal #{r.deal_id}</div>
                </td>
                <td>
                  <div className="burn" title={`${r.actual_hours}h / ${r.planned_hours}h`}>
                    <span className={r.health_calc} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {Math.round(Number(r.actual_hours))}h / {Math.round(Number(r.planned_hours))}h
                  </div>
                </td>
                <td className="right">{money(Number(r.recognized_month))}</td>
                <td className="right">{money(Number(r.gap_month))}</td>
                <td><span className={`chip ${invStatus}`}>{invStatus}</span></td>
                <td><span className={`dot ${r.health_calc}`} title={r.health_calc} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
