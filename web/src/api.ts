import type { DashboardRow, RevenueRow, ExceptionRow, TrendRow } from './types';

// Base URL of the standalone Function App, injected at build time.
// e.g. VITE_API_BASE=https://projtrack-func-xxxx.azurewebsites.net/api
const BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include', // forwards the SWA auth cookie/principal
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  dashboard: () => get<DashboardRow[]>('/dashboard'),
  revenue: () => get<RevenueRow[]>('/revenue'),
  exceptions: () => get<ExceptionRow[]>('/exceptions'),
  trend: (dealId: number) => get<TrendRow[]>(`/deal/${dealId}/trend`),
};
