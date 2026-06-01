// Shapes returned by the read API (mirror the DB views/functions).

export type Health = 'green' | 'amber' | 'red';

export interface DashboardRow {
  project_id: string;
  deal_id: number;
  project_name: string;
  contract_value: number;
  planned_hours: number;
  actual_hours: number;
  percent_complete: number;
  hours_consumed_pct: number;
  health_calc: Health;
  recognized_month: number;
  invoiced_month: number;
  gap_month: number;
  status: string;
  health_stored: Health;
}

export interface RevenueRow {
  period_month: string;
  recognized_amount: number;
  invoiced_amount: number;
  gap_amount: number;
}

export type ExceptionType = 'missing' | 'overdue' | 'pending';

export interface ExceptionRow {
  project_id: string;
  deal_id: number;
  project_name: string;
  period_month: string;
  recognized_amount: number;
  invoiced_amount: number;
  gap_amount: number;
  exception_type: ExceptionType;
}

export interface TrendRow {
  week_start: string;
  actual_hours: number;
  hours_delta: number | null;
  percent_complete: number;
  pct_delta: number | null;
  invoicing_gap: number;
  health: Health;
}
