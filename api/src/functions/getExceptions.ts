import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { query } from '../shared/db';
import { json, error, isAuthenticated } from '../shared/respond';

/** GET /api/exceptions → projects with an under-invoiced gap. */
export async function getExceptions(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return error('Unauthorized', 401);
  try {
    const r = await query('SELECT * FROM v_invoicing_exceptions');
    return json(r.rows);
  } catch (err) {
    ctx.error('getExceptions failed', err);
    return error('Failed to load exceptions');
  }
}

app.http('getExceptions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'exceptions',
  handler: getExceptions,
});
