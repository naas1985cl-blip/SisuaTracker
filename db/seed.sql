-- =============================================================================
-- Sample data so the dashboard renders before the first real sync runs.
-- Safe to run repeatedly (idempotent upserts). Run AFTER schema.sql:
--   psql "...projecttracker..." -f db/seed.sql
-- =============================================================================

-- Deals -----------------------------------------------------------------------
INSERT INTO deals (deal_id, title, contract_value, sold_hours, recognition_method) VALUES
  (1001, 'Acme Corp — Data Platform',     120000, 800, 'percent_completion'),
  (1002, 'Globex — Mobile App',            64000,  400, 'percent_completion'),
  (1003, 'Initech — BI Dashboards',        30000,  200, 'percent_completion'),
  (1004, 'Umbrella — Cloud Migration',     90000,  600, 'milestone')
ON CONFLICT (deal_id) DO UPDATE
  SET title = EXCLUDED.title,
      contract_value = EXCLUDED.contract_value,
      sold_hours = EXCLUDED.sold_hours,
      recognition_method = EXCLUDED.recognition_method;

-- Projects --------------------------------------------------------------------
INSERT INTO projects (deal_id, clickup_id, name, planned_hours, actual_hours, percent_complete, health, status) VALUES
  (1001, 'cu_900', 'Acme Data Platform',  800, 520, 60.00, 'green', 'in_execution'),
  (1002, 'cu_901', 'Globex Mobile App',   400, 372, 80.00, 'amber', 'in_execution'),
  (1003, 'cu_902', 'Initech BI',          200, 230, 95.00, 'red',   'in_execution'),
  (1004, 'cu_903', 'Umbrella Migration',  600, 120, 20.00, 'green', 'in_execution')
ON CONFLICT (deal_id) DO UPDATE
  SET clickup_id = EXCLUDED.clickup_id,
      name = EXCLUDED.name,
      planned_hours = EXCLUDED.planned_hours,
      actual_hours = EXCLUDED.actual_hours,
      percent_complete = EXCLUDED.percent_complete,
      health = EXCLUDED.health,
      status = EXCLUDED.status;

-- Invoices (current month) ----------------------------------------------------
-- deal 1001 partly billed, 1002 billed, 1003 NOT billed (exception), 1004 none
INSERT INTO invoices (deal_id, pipedrive_invoice_id, amount, status, period_month) VALUES
  (1001, 'pdinv_5001', 40000, 'sent', date_trunc('month', current_date)::date),
  (1002, 'pdinv_5002', 30000, 'paid', date_trunc('month', current_date)::date),
  (1004, 'pdinv_5003', 10000, 'sent', date_trunc('month', current_date)::date)
ON CONFLICT (pipedrive_invoice_id) DO UPDATE
  SET amount = EXCLUDED.amount,
      status = EXCLUDED.status,
      period_month = EXCLUDED.period_month;

-- Build a few weeks of recognition + snapshots so the trend view has data.
-- We call finalize_week()'s math inline for the current month, then fabricate
-- three prior weekly snapshots per project for week-over-week visualization.
INSERT INTO revenue_recognition (project_id, deal_id, period_month, recognized_amount, invoiced_amount)
SELECT p.id, p.deal_id, date_trunc('month', current_date)::date,
       round(d.contract_value * (p.percent_complete/100.0), 2),
       COALESCE((SELECT sum(i.amount) FROM invoices i
                 WHERE i.deal_id = p.deal_id
                   AND i.period_month = date_trunc('month', current_date)::date
                   AND i.status <> 'void'), 0)
FROM projects p JOIN deals d ON d.deal_id = p.deal_id
ON CONFLICT (project_id, period_month) DO UPDATE
  SET recognized_amount = EXCLUDED.recognized_amount,
      invoiced_amount = EXCLUDED.invoiced_amount,
      updated_at = now();

-- Three trailing weekly snapshots (this Monday, -1w, -2w) with rising hours.
INSERT INTO weekly_snapshots
  (project_id, deal_id, week_start, planned_hours, actual_hours, percent_complete, health, recognized_mtd, invoiced_mtd)
SELECT p.id, p.deal_id,
       iso_week_monday(current_date) - (w.offset_weeks * 7),
       p.planned_hours,
       round(p.actual_hours * (1 - 0.12 * w.offset_weeks), 2),
       round(p.percent_complete * (1 - 0.12 * w.offset_weeks), 2),
       CASE
         WHEN p.planned_hours > 0 AND (p.actual_hours * (1 - 0.12 * w.offset_weeks)) > p.planned_hours THEN 'red'
         WHEN p.planned_hours > 0 AND (p.actual_hours * (1 - 0.12 * w.offset_weeks)) / p.planned_hours >= 0.90 THEN 'amber'
         ELSE 'green'
       END::project_health,
       COALESCE((SELECT recognized_amount FROM revenue_recognition rr
                 WHERE rr.project_id = p.id
                   AND rr.period_month = date_trunc('month', current_date)::date), 0),
       COALESCE((SELECT invoiced_amount FROM revenue_recognition rr
                 WHERE rr.project_id = p.id
                   AND rr.period_month = date_trunc('month', current_date)::date), 0)
FROM projects p
CROSS JOIN (VALUES (0), (1), (2)) AS w(offset_weeks)
ON CONFLICT (project_id, week_start) DO NOTHING;
