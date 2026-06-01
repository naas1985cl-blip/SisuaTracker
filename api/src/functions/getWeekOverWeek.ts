import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { query } from '../shared/db';
import { json, error, isAuthenticated } from '../shared/respond';

/** GET /api/deal/{dealId}/trend → week-over-week trend for one deal. */
export async function getWeekOverWeek(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return error('Unauthorized', 401);

  const dealId = Number(req.params.dealId);
  if (!Number.isInteger(dealId)) return error('Invalid dealId', 400);

  try {
    const r = await query('SELECT * FROM f_week_over_week($1)', [dealId]);
    return json(r.rows);
  } catch (err) {
    ctx.error('getWeekOverWeek failed', err);
    return error('Failed to load trend');
  }
}

app.http('getWeekOverWeek', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'deal/{dealId}/trend',
  handler: getWeekOverWeek,
});
