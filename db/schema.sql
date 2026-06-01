-- =============================================================================
-- Project Tracking Dashboard — Authoritative data layer
-- Run ONCE against the `projecttracker` database after provisioning:
--   psql "host=<fqdn> port=5432 dbname=projecttracker user=pgadmin sslmode=require" -f db/schema.sql
--
-- Design principle: business logic lives HERE, not in the app. The API only
-- ever SELECTs from the v_* views and calls f_week_over_week(). The weekly
-- recognition + snapshot math is in finalize_week().
-- PostgreSQL 16. No pg_cron (scheduling is in the Azure Function). No RLS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('planning', 'in_execution', 'on_hold', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_health AS ENUM ('green', 'amber', 'red');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'void');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE recognition_method AS ENUM ('percent_completion', 'milestone', 'on_delivery');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync_source AS ENUM ('pipedrive_deals', 'pipedrive_invoicing', 'clickup', 'finalize');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync_status AS ENUM ('running', 'success', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- deal_id (bigint) is the shared join key across PipeDrive + ClickUp.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deals (
  deal_id            bigint PRIMARY KEY,
  title              text,
  contract_value     numeric(14,2) NOT NULL DEFAULT 0,
  sold_hours         numeric(10,2) NOT NULL DEFAULT 0,
  recognition_method recognition_method NOT NULL DEFAULT 'percent_completion',
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id          bigint NOT NULL UNIQUE REFERENCES deals(deal_id) ON DELETE CASCADE,
  clickup_id       text UNIQUE,
  name             text,
  planned_hours    numeric(10,2) NOT NULL DEFAULT 0,
  actual_hours     numeric(10,2) NOT NULL DEFAULT 0,
  percent_complete numeric(5,2)  NOT NULL DEFAULT 0,
  health           project_health NOT NULL DEFAULT 'green',
  status           project_status NOT NULL DEFAULT 'in_execution',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  clickup_task_id text NOT NULL UNIQUE,
  name            text,
  estimate_hours  numeric(10,2) NOT NULL DEFAULT 0,
  logged_hours    numeric(10,2) NOT NULL DEFAULT 0,
  is_closed       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id              bigint NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  pipedrive_invoice_id text NOT NULL UNIQUE,
  amount               numeric(14,2) NOT NULL DEFAULT 0,
  status               invoice_status NOT NULL DEFAULT 'draft',
  period_month         date NOT NULL, -- first day of the issue month
  raw                  jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revenue_recognition (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deal_id          bigint NOT NULL REFERENCES deals(deal_id) ON DELETE CASCADE,
  period_month     date NOT NULL,
  recognized_amount numeric(14,2) NOT NULL DEFAULT 0,
  invoiced_amount   numeric(14,2) NOT NULL DEFAULT 0,
  -- gap = what we earned minus what we billed; positive = under-invoiced
  gap_amount        numeric(14,2) GENERATED ALWAYS AS (recognized_amount - invoiced_amount) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, period_month)
);

CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deal_id          bigint NOT NULL,
  week_start       date NOT NULL,
  planned_hours    numeric(10,2) NOT NULL DEFAULT 0,
  actual_hours     numeric(10,2) NOT NULL DEFAULT 0,
  percent_complete numeric(5,2)  NOT NULL DEFAULT 0,
  health           project_health NOT NULL DEFAULT 'green',
  recognized_mtd   numeric(14,2) NOT NULL DEFAULT 0,
  invoiced_mtd     numeric(14,2) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- week_start must always be a Monday (ISO day-of-week 1)
  CONSTRAINT week_start_is_monday CHECK (extract(isodow from week_start) = 1),
  UNIQUE (project_id, week_start)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          sync_source NOT NULL,
  status          sync_status NOT NULL,
  records_read    integer NOT NULL DEFAULT 0,
  records_upserted integer NOT NULL DEFAULT 0,
  error_detail    text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes — every FK plus the hot query columns
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_projects_deal_id            ON projects(deal_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id    ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_deal_id            ON invoices(deal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_period_month       ON invoices(period_month);
CREATE INDEX IF NOT EXISTS idx_revrec_project_id           ON revenue_recognition(project_id);
CREATE INDEX IF NOT EXISTS idx_revrec_deal_id              ON revenue_recognition(deal_id);
CREATE INDEX IF NOT EXISTS idx_revrec_period_month         ON revenue_recognition(period_month);
CREATE INDEX IF NOT EXISTS idx_snapshots_project_id        ON weekly_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_week_start        ON weekly_snapshots(week_start);
CREATE INDEX IF NOT EXISTS idx_snapshots_deal_id           ON weekly_snapshots(deal_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_source_status      ON sync_log(source, status, finished_at);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deals_updated_at ON deals;
CREATE TRIGGER trg_deals_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Monday of the ISO week containing the given date.
CREATE OR REPLACE FUNCTION iso_week_monday(p_date date)
RETURNS date AS $$
  SELECT (p_date - ((extract(isodow from p_date)::int - 1)))::date;
$$ LANGUAGE sql IMMUTABLE;

-- Watermark for incremental pulls: most recent successful finish for a source.
CREATE OR REPLACE FUNCTION last_success(p_source sync_source)
RETURNS timestamptz AS $$
  SELECT max(finished_at)
  FROM sync_log
  WHERE source = p_source AND status = 'success';
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Views — the ONLY surface the read API touches
-- ---------------------------------------------------------------------------

-- One row per in-execution project, enriched with current-month rev/invoice.
CREATE OR REPLACE VIEW v_project_dashboard AS
SELECT
  p.id                              AS project_id,
  p.deal_id,
  COALESCE(p.name, d.title)         AS project_name,
  d.contract_value,
  p.planned_hours,
  p.actual_hours,
  p.percent_complete,
  CASE
    WHEN p.planned_hours > 0
      THEN round((p.actual_hours / p.planned_hours) * 100, 2)
    ELSE 0
  END                               AS hours_consumed_pct,
  -- Health recomputed live: red if over budget, amber if >=90% burned, else green
  CASE
    WHEN p.planned_hours > 0 AND p.actual_hours > p.planned_hours THEN 'red'
    WHEN p.planned_hours > 0 AND (p.actual_hours / p.planned_hours) >= 0.90 THEN 'amber'
    ELSE 'green'
  END::project_health               AS health_calc,
  COALESCE(rr.recognized_amount, 0) AS recognized_month,
  COALESCE(rr.invoiced_amount, 0)   AS invoiced_month,
  COALESCE(rr.gap_amount, 0)        AS gap_month,
  p.status,
  p.health                          AS health_stored
FROM projects p
JOIN deals d ON d.deal_id = p.deal_id
LEFT JOIN revenue_recognition rr
  ON rr.project_id = p.id
 AND rr.period_month = date_trunc('month', current_date)::date
WHERE p.status = 'in_execution';

-- Recognized / invoiced / gap totals grouped by month.
CREATE OR REPLACE VIEW v_revenue_by_month AS
SELECT
  period_month,
  sum(recognized_amount) AS recognized_amount,
  sum(invoiced_amount)   AS invoiced_amount,
  sum(gap_amount)        AS gap_amount
FROM revenue_recognition
GROUP BY period_month
ORDER BY period_month;

-- Projects where we've recognized more than we've invoiced this month.
CREATE OR REPLACE VIEW v_invoicing_exceptions AS
SELECT
  p.id                       AS project_id,
  p.deal_id,
  COALESCE(p.name, d.title)  AS project_name,
  rr.period_month,
  rr.recognized_amount,
  rr.invoiced_amount,
  rr.gap_amount,
  CASE
    WHEN rr.invoiced_amount = 0 THEN 'missing'
    WHEN rr.period_month < date_trunc('month', current_date)::date THEN 'overdue'
    ELSE 'pending'
  END AS exception_type
FROM revenue_recognition rr
JOIN projects p ON p.id = rr.project_id
JOIN deals d ON d.deal_id = rr.deal_id
WHERE rr.gap_amount > 0
ORDER BY rr.gap_amount DESC;

-- ---------------------------------------------------------------------------
-- Week-over-week trend for one deal (powers the trend view).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_week_over_week(p_deal_id bigint)
RETURNS TABLE (
  week_start       date,
  actual_hours     numeric,
  hours_delta      numeric,
  percent_complete numeric,
  pct_delta        numeric,
  invoicing_gap    numeric,
  health           project_health
) AS $$
  SELECT
    ws.week_start,
    ws.actual_hours,
    ws.actual_hours - lag(ws.actual_hours) OVER w        AS hours_delta,
    ws.percent_complete,
    ws.percent_complete - lag(ws.percent_complete) OVER w AS pct_delta,
    (ws.recognized_mtd - ws.invoiced_mtd)                AS invoicing_gap,
    ws.health
  FROM weekly_snapshots ws
  WHERE ws.deal_id = p_deal_id
  WINDOW w AS (ORDER BY ws.week_start)
  ORDER BY ws.week_start;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- finalize_week() — the guard + recognition + snapshot.
-- Returns a human-readable status string (also logged to sync_log).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finalize_week()
RETURNS text AS $$
DECLARE
  v_sources_ok int;
  v_week       date := iso_week_monday(current_date);
  v_month      date := date_trunc('month', current_date)::date;
  v_msg        text;
BEGIN
  -- 1) GUARD: require a recent success from all three ingest sources, so we
  --    never snapshot a half-loaded week.
  SELECT count(DISTINCT source) INTO v_sources_ok
  FROM sync_log
  WHERE status = 'success'
    AND source IN ('pipedrive_deals', 'pipedrive_invoicing', 'clickup')
    AND finished_at >= now() - interval '6 hours';

  IF v_sources_ok < 3 THEN
    v_msg := 'ABORTED: only ' || v_sources_ok ||
             '/3 ingest sources succeeded in the last 6h; week not finalized.';
    INSERT INTO sync_log (source, status, error_detail, finished_at)
    VALUES ('finalize', 'failed', v_msg, now());
    RETURN v_msg;
  END IF;

  -- 2) Upsert revenue recognition for the current month.
  --    recognized = contract_value * percent_complete/100
  --    invoiced   = sum of this deal's invoices issued in this month.
  INSERT INTO revenue_recognition (project_id, deal_id, period_month, recognized_amount, invoiced_amount)
  SELECT
    p.id,
    p.deal_id,
    v_month,
    round(d.contract_value * (p.percent_complete / 100.0), 2),
    COALESCE((
      SELECT sum(i.amount)
      FROM invoices i
      WHERE i.deal_id = p.deal_id
        AND i.period_month = v_month
        AND i.status <> 'void'
    ), 0)
  FROM projects p
  JOIN deals d ON d.deal_id = p.deal_id
  WHERE p.status = 'in_execution'
  ON CONFLICT (project_id, period_month) DO UPDATE
    SET recognized_amount = EXCLUDED.recognized_amount,
        invoiced_amount   = EXCLUDED.invoiced_amount,
        updated_at        = now();

  -- 3) Upsert this week's snapshot with the live health calc.
  INSERT INTO weekly_snapshots
    (project_id, deal_id, week_start, planned_hours, actual_hours,
     percent_complete, health, recognized_mtd, invoiced_mtd)
  SELECT
    p.id,
    p.deal_id,
    v_week,
    p.planned_hours,
    p.actual_hours,
    p.percent_complete,
    CASE
      WHEN p.planned_hours > 0 AND p.actual_hours > p.planned_hours THEN 'red'
      WHEN p.planned_hours > 0 AND (p.actual_hours / p.planned_hours) >= 0.90 THEN 'amber'
      ELSE 'green'
    END::project_health,
    COALESCE(rr.recognized_amount, 0),
    COALESCE(rr.invoiced_amount, 0)
  FROM projects p
  LEFT JOIN revenue_recognition rr
    ON rr.project_id = p.id AND rr.period_month = v_month
  WHERE p.status = 'in_execution'
  ON CONFLICT (project_id, week_start) DO UPDATE
    SET planned_hours    = EXCLUDED.planned_hours,
        actual_hours     = EXCLUDED.actual_hours,
        percent_complete = EXCLUDED.percent_complete,
        health           = EXCLUDED.health,
        recognized_mtd   = EXCLUDED.recognized_mtd,
        invoiced_mtd     = EXCLUDED.invoiced_mtd;

  -- 4) Success.
  v_msg := 'OK: week ' || v_week || ' finalized.';
  INSERT INTO sync_log (source, status, finished_at)
  VALUES ('finalize', 'success', now());
  RETURN v_msg;
END;
$$ LANGUAGE plpgsql;
