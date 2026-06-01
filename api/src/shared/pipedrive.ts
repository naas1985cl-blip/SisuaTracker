import { fetchJson } from './http';
import { getSecret } from './secrets';

/**
 * PipeDrive API client — pulls deals (sales pipeline) and invoices
 * (invoicing pipeline). Everything is keyed on `deal_id`, the shared join key.
 *
 * Uses the v2 API with cursor pagination and `updated_since` for incremental
 * pulls. The API token is read from the Key Vault secret `pipedrive-token`.
 */

const BASE = 'https://api.pipedrive.com';

// -----------------------------------------------------------------------------
// CONFIGURE THESE before going live (see README §1):
//   SOLD_HOURS_FIELD — the PipeDrive custom-field key holding sold/budget hours.
//   INVOICING_PIPELINE_ID — the pipeline id whose deals represent invoices.
// PipeDrive custom-field keys are 40-char hashes shown in the field's settings.
// -----------------------------------------------------------------------------
export const SOLD_HOURS_FIELD = 'REPLACE_WITH_SOLD_HOURS_FIELD_KEY';
export const INVOICING_PIPELINE_ID = 0; // set to your invoicing pipeline id

/** Maps a PipeDrive deal stage/status string to our invoice_status enum. */
function mapInvoiceStatus(raw: string | null | undefined): string {
  switch ((raw ?? '').toLowerCase()) {
    case 'paid':
    case 'won':
      return 'paid';
    case 'sent':
    case 'open':
      return 'sent';
    case 'overdue':
      return 'overdue';
    case 'lost':
    case 'deleted':
      return 'void';
    default:
      return 'draft';
  }
}

export interface DealRow {
  deal_id: number;
  title: string | null;
  contract_value: number;
  sold_hours: number;
  raw: unknown;
}

export interface InvoiceRow {
  deal_id: number;
  pipedrive_invoice_id: string;
  amount: number;
  status: string;
  period_month: string; // YYYY-MM-01
  raw: unknown;
}

interface PdV2Response<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: {
    next_cursor?: string | null;
  };
}

async function token(): Promise<string> {
  return getSecret('pipedrive-token');
}

/** Build a v2 URL with api_token + query params. */
function url(path: string, params: Record<string, string | number>): string {
  const u = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** First day of the month for a given ISO date/datetime string. */
function firstOfMonth(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Pull deals updated since the watermark. Incremental + cursor-paginated.
 * Maps each deal to the `deals` table shape, reading sold_hours from a custom
 * field.
 */
export async function pullDeals(since: string | null): Promise<DealRow[]> {
  const apiToken = await token();
  const rows: DealRow[] = [];
  let cursor: string | null | undefined;

  do {
    const params: Record<string, string | number> = {
      api_token: apiToken,
      limit: 100,
    };
    if (since) params.updated_since = since;
    if (cursor) params.cursor = cursor;

    const resp = await fetchJson<PdV2Response<Record<string, unknown>>>(
      url('/api/v2/deals', params)
    );

    for (const d of resp.data ?? []) {
      const dealId = Number(d.id);
      if (!Number.isFinite(dealId)) continue;
      rows.push({
        deal_id: dealId,
        title: (d.title as string) ?? null,
        contract_value: Number(d.value ?? 0),
        sold_hours: Number((d as Record<string, unknown>)[SOLD_HOURS_FIELD] ?? 0),
        raw: d,
      });
    }

    cursor = resp.additional_data?.next_cursor;
  } while (cursor);

  return rows;
}

/**
 * Pull invoices from the invoicing pipeline since the watermark. MUST carry
 * `deal_id` (the join key). Deals in the invoicing pipeline are treated as
 * invoices: amount = deal value, deal_id = the related/origin deal id.
 */
export async function pullInvoices(since: string | null): Promise<InvoiceRow[]> {
  const apiToken = await token();
  const rows: InvoiceRow[] = [];
  let cursor: string | null | undefined;

  do {
    const params: Record<string, string | number> = {
      api_token: apiToken,
      limit: 100,
    };
    if (INVOICING_PIPELINE_ID) params.pipeline_id = INVOICING_PIPELINE_ID;
    if (since) params.updated_since = since;
    if (cursor) params.cursor = cursor;

    const resp = await fetchJson<PdV2Response<Record<string, unknown>>>(
      url('/api/v2/deals', params)
    );

    for (const d of resp.data ?? []) {
      // The invoicing deal must reference the originating sales deal id. We try
      // a couple of common locations; adjust to your PipeDrive setup.
      const dealId = Number(
        (d as Record<string, unknown>)['origin_deal_id'] ??
          (d as Record<string, unknown>)['related_deal_id'] ??
          d.id
      );
      if (!Number.isFinite(dealId)) continue;

      const statusRaw =
        (d.status as string) ?? (d.stage_id !== undefined ? String(d.stage_id) : null);

      rows.push({
        deal_id: dealId,
        pipedrive_invoice_id: String(d.id),
        amount: Number(d.value ?? 0),
        status: mapInvoiceStatus(statusRaw),
        period_month: firstOfMonth((d.add_time as string) ?? (d.update_time as string)),
        raw: d,
      });
    }

    cursor = resp.additional_data?.next_cursor;
  } while (cursor);

  return rows;
}
