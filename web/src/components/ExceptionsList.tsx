import type { ExceptionRow } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Missing/overdue invoicing worklist, sorted by gap (API already sorts desc). */
export function ExceptionsList({ rows }: { rows: ExceptionRow[] }) {
  if (rows.length === 0) return <div className="empty">No invoicing exceptions. 🎉</div>;

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Type</th>
            <th className="right">Recognized</th>
            <th className="right">Invoiced</th>
            <th className="right">Gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.project_id}-${r.period_month}`}>
              <td>
                <div>{r.project_name}</div>
                <div className="muted" style={{ fontSize: 12 }}>deal #{r.deal_id}</div>
              </td>
              <td><span className={`chip ${r.exception_type}`}>{r.exception_type}</span></td>
              <td className="right">{money(Number(r.recognized_amount))}</td>
              <td className="right">{money(Number(r.invoiced_amount))}</td>
              <td className="right"><strong>{money(Number(r.gap_amount))}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
