import { app, InvocationContext, Timer } from '@azure/functions';
import { query, withTransaction } from '../shared/db';
import { pullDeals, pullInvoices, DealRow, InvoiceRow } from '../shared/pipedrive';
import { pullProjects, pullTasks } from '../shared/clickup';
import type { PoolClient } from 'pg';

/**
 * Weekly sync orchestrator (Timer trigger).
 *
 * Schedule: `0 0 1 * * 0` — six-field NCRONTAB = Sunday 01:00 UTC.
 * (Leading field is SECONDS in Azure Functions NCRONTAB.)
 *
 * Each ingest step is wrapped so it opens a `sync_log` row at start and closes
 * it with counts + status. Every external write is an idempotent upsert keyed
 * on the source id, so re-running the job never duplicates rows. After all
 * three sources load, we call DB `finalize_week()` which guards + snapshots.
 */

const BATCH = 500;

/** ISO timestamp watermark for a source, or null if never succeeded. */
async function watermark(source: string): Promise<string | null> {
  const r = await query<{ ts: string | null }>(
    'SELECT last_success($1::sync_source) AS ts',
    [source]
  );
  return r.rows[0]?.ts ?? null;
}

/** Open a sync_log row; returns its id. */
async function openLog(source: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO sync_log (source, status, started_at)
     VALUES ($1::sync_source, 'running', now()) RETURNING id`,
    [source]
  );
  return r.rows[0].id;
}

async function closeLogSuccess(id: string, read: number, upserted: number): Promise<void> {
  await query(
    `UPDATE sync_log SET status='success', records_read=$2,
        records_upserted=$3, finished_at=now() WHERE id=$1`,
    [id, read, upserted]
  );
}

async function closeLogFailed(id: string, err: unknown): Promise<void> {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  await query(
    `UPDATE sync_log SET status='failed', error_detail=$2, finished_at=now() WHERE id=$1`,
    [id, detail.slice(0, 4000)]
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Step 1 — deals
// ---------------------------------------------------------------------------
async function syncDeals(ctx: InvocationContext): Promise<void> {
  const id = await openLog('pipedrive_deals');
  try {
    const since = await watermark('pipedrive_deals');
    const deals = await pullDeals(since);
    let upserted = 0;

    for (const batch of chunk(deals, BATCH)) {
      await withTransaction(async (c: PoolClient) => {
        for (const d of batch) {
          await c.query(
            `INSERT INTO deals (deal_id, title, contract_value, sold_hours, raw)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (deal_id) DO UPDATE
               SET title=EXCLUDED.title,
                   contract_value=EXCLUDED.contract_value,
                   sold_hours=EXCLUDED.sold_hours,
                   raw=EXCLUDED.raw`,
            [d.deal_id, d.title, d.contract_value, d.sold_hours, d.raw as DealRow['raw']]
          );
          upserted++;
        }
      });
    }

    await closeLogSuccess(id, deals.length, upserted);
    ctx.log(`deals: read ${deals.length}, upserted ${upserted}`);
  } catch (err) {
    await closeLogFailed(id, err);
    ctx.error('deals sync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Step 2 — invoices
// ---------------------------------------------------------------------------
async function syncInvoices(ctx: InvocationContext): Promise<void> {
  const id = await openLog('pipedrive_invoicing');
  try {
    const since = await watermark('pipedrive_invoicing');
    const invoices = await pullInvoices(since);
    let upserted = 0;

    for (const batch of chunk(invoices, BATCH)) {
      await withTransaction(async (c: PoolClient) => {
        for (const inv of batch) {
          // Skip invoices whose deal isn't loaded yet (FK safety).
          const exists = await c.query('SELECT 1 FROM deals WHERE deal_id=$1', [inv.deal_id]);
          if (exists.rowCount === 0) continue;

          await c.query(
            `INSERT INTO invoices
               (deal_id, pipedrive_invoice_id, amount, status, period_month, raw)
             VALUES ($1, $2, $3, $4::invoice_status, $5, $6)
             ON CONFLICT (pipedrive_invoice_id) DO UPDATE
               SET deal_id=EXCLUDED.deal_id,
                   amount=EXCLUDED.amount,
                   status=EXCLUDED.status,
                   period_month=EXCLUDED.period_month,
                   raw=EXCLUDED.raw`,
            [
              inv.deal_id,
              inv.pipedrive_invoice_id,
              inv.amount,
              inv.status,
              inv.period_month,
              inv.raw as InvoiceRow['raw'],
            ]
          );
          upserted++;
        }
      });
    }

    await closeLogSuccess(id, invoices.length, upserted);
    ctx.log(`invoices: read ${invoices.length}, upserted ${upserted}`);
  } catch (err) {
    await closeLogFailed(id, err);
    ctx.error('invoices sync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — ClickUp projects + tasks, then roll up hours
// ---------------------------------------------------------------------------
async function syncClickUp(ctx: InvocationContext): Promise<void> {
  const id = await openLog('clickup');
  try {
    const projects = await pullProjects();
    let read = 0;
    let upserted = 0;

    for (const proj of projects) {
      // Project's deal must exist (FK).
      const dealExists = await query('SELECT 1 FROM deals WHERE deal_id=$1', [proj.deal_id]);
      if (dealExists.rowCount === 0) {
        ctx.warn(`skip project ${proj.clickup_id}: deal ${proj.deal_id} not loaded`);
        continue;
      }

      const tasks = await pullTasks(proj.clickup_id);
      read += tasks.length;

      const plannedHours = tasks.reduce((s, t) => s + t.estimate_hours, 0);
      const actualHours = tasks.reduce((s, t) => s + t.logged_hours, 0);
      const closed = tasks.filter((t) => t.is_closed).length;
      const pctComplete = tasks.length > 0 ? (closed / tasks.length) * 100 : 0;

      await withTransaction(async (c: PoolClient) => {
        // Upsert the project and capture its uuid.
        const pr = await c.query<{ id: string }>(
          `INSERT INTO projects
             (deal_id, clickup_id, name, planned_hours, actual_hours, percent_complete)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (deal_id) DO UPDATE
             SET clickup_id=EXCLUDED.clickup_id,
                 name=EXCLUDED.name,
                 planned_hours=EXCLUDED.planned_hours,
                 actual_hours=EXCLUDED.actual_hours,
                 percent_complete=EXCLUDED.percent_complete
           RETURNING id`,
          [
            proj.deal_id,
            proj.clickup_id,
            proj.name,
            plannedHours,
            actualHours,
            pctComplete,
          ]
        );
        const projectId = pr.rows[0].id;

        for (const t of tasks) {
          await c.query(
            `INSERT INTO project_tasks
               (project_id, clickup_task_id, name, estimate_hours, logged_hours, is_closed)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (clickup_task_id) DO UPDATE
               SET project_id=EXCLUDED.project_id,
                   name=EXCLUDED.name,
                   estimate_hours=EXCLUDED.estimate_hours,
                   logged_hours=EXCLUDED.logged_hours,
                   is_closed=EXCLUDED.is_closed`,
            [projectId, t.clickup_task_id, t.name, t.estimate_hours, t.logged_hours, t.is_closed]
          );
          upserted++;
        }
      });
    }

    await closeLogSuccess(id, read, upserted);
    ctx.log(`clickup: ${projects.length} projects, read ${read} tasks, upserted ${upserted}`);
  } catch (err) {
    await closeLogFailed(id, err);
    ctx.error('clickup sync failed', err);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
export async function syncWeekly(_timer: Timer, ctx: InvocationContext): Promise<void> {
  ctx.log('syncWeekly: starting weekly run');

  // Order matters: deals first (FK target), then invoices + clickup.
  await syncDeals(ctx);
  await syncInvoices(ctx);
  await syncClickUp(ctx);

  // The DB guard decides whether to snapshot a fully-loaded week.
  const result = await query<{ finalize_week: string }>('SELECT finalize_week()');
  const message = result.rows[0]?.finalize_week ?? '(no result)';
  ctx.log(`finalize_week → ${message}`);
}

app.timer('syncWeekly', {
  schedule: '0 0 1 * * 0', // Sunday 01:00 UTC (sec min hour day month dow)
  runOnStartup: false,
  handler: syncWeekly,
});
