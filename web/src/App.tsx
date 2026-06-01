import { useEffect, useState } from 'react';
import { api } from './api';
import type { DashboardRow, RevenueRow, ExceptionRow } from './types';
import { KpiStrip } from './components/KpiStrip';
import { ProjectTable } from './components/ProjectTable';
import { RevenueChart } from './components/RevenueChart';
import { ExceptionsList } from './components/ExceptionsList';
import { WeekOverWeek } from './components/WeekOverWeek';

interface Selection {
  dealId: number;
  name: string;
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardRow[] | null>(null);
  const [revenue, setRevenue] = useState<RevenueRow[] | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);

  useEffect(() => {
    Promise.all([api.dashboard(), api.revenue(), api.exceptions()])
      .then(([d, r, e]) => {
        setDashboard(d);
        setRevenue(r);
        setExceptions(e);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const loading = !dashboard && !error;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Project Tracker</h1>
          <div className="sub">Budget vs. hours · revenue recognition · invoicing gaps</div>
        </div>
        <a className="sub" href="/logout">Sign out</a>
      </header>

      {error && <div className="error">Failed to load: {error}</div>}
      {loading && <div className="loading">Loading dashboard…</div>}

      {dashboard && (
        <>
          <KpiStrip rows={dashboard} />

          <section className="section">
            <h2>Projects</h2>
            <ProjectTable
              rows={dashboard}
              onSelect={(dealId, name) => setSelected({ dealId, name })}
            />
          </section>

          <section className="section">
            <h2>Monthly revenue recognition</h2>
            <RevenueChart rows={revenue ?? []} />
          </section>

          <section className="section">
            <h2>Invoicing exceptions</h2>
            <ExceptionsList rows={exceptions ?? []} />
          </section>
        </>
      )}

      {selected && (
        <WeekOverWeek
          dealId={selected.dealId}
          name={selected.name}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
