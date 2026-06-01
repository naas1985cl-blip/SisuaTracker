import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { query } from '../shared/db';
import { json, error, isAuthenticated } from '../shared/respond';

/** GET /api/revenue → recognized/invoiced/gap totals by month. */
export async function getRevenue(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return error('Unauthorized', 401);
  try {
    const r = await query('SELECT * FROM v_revenue_by_month');
    return json(r.rows);
  } catch (err) {
    ctx.error('getRevenue failed', err);
    return error('Failed to load revenue');
  }
}

app.http('getRevenue', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'revenue',
  handler: getRevenue,
});
