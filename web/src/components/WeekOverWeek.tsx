import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TrendRow } from '../types';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const weekLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function Delta({ value, unit }: { value: number | null; unit: string }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const n = Number(value);
  if (n === 0) return <span className="muted">0{unit}</span>;
  const cls = n > 0 ? 'delta-up' : 'delta-down';
  return (
    <span className={cls}>
      {n > 0 ? '▲' : '▼'} {Math.abs(n).toFixed(1)}{unit}
    </span>
  );
}

/** Slide-over drawer: week-over-week trend for a single deal. */
export function WeekOverWeek({
  dealId,
  name,
  onClose,
}: {
  dealId: number;
  name: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TrendRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .trend(dealId)
      .then((r) => active && setRows(r))
      .catch((e) => active && setErr(String(e)));
    return () => {
      active = false;
    };
  }, [dealId]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2 style={{ margin: 0 }}>{name}</h2>
            <div className="muted" style={{ fontSize: 12 }}>deal #{dealId} · week over week</div>
          </div>
          <button onClick={onClose} aria-label="Close">×</button>
        </header>

        {err && <div className="error">{err}</div>}
        {!rows && !err && <div className="loading">Loading trend…</div>}
        {rows && rows.length === 0 && <div className="empty">No snapshots yet for this deal.</div>}

        {rows && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th className="right">Hours</th>
                <th className="right">Δ hrs</th>
                <th className="right">% done</th>
                <th className="right">Δ %</th>
                <th className="right">Gap</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.week_start}>
                  <td>{weekLabel(r.week_start)}</td>
                  <td className="right">{Math.round(Number(r.actual_hours))}h</td>
                  <td className="right"><Delta value={r.hours_delta} unit="h" /></td>
                  <td className="right">{Number(r.percent_complete).toFixed(0)}%</td>
                  <td className="right"><Delta value={r.pct_delta} unit="%" /></td>
                  <td className="right">{money(Number(r.invoicing_gap))}</td>
                  <td><span className={`dot ${r.health}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
