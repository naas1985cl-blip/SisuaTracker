import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { query } from '../shared/db';
import { json, error, isAuthenticated } from '../shared/respond';

/** GET /api/dashboard → one row per in-execution project. */
export async function getDashboard(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  if (!isAuthenticated(req)) return error('Unauthorized', 401);
  try {
    const r = await query('SELECT * FROM v_project_dashboard');
    return json(r.rows);
  } catch (err) {
    ctx.error('getDashboard failed', err);
    return error('Failed to load dashboard');
  }
}

app.http('getDashboard', {
  methods: ['GET'],
  authLevel: 'anonymous', // SWA Entra ID gates access upstream
  route: 'dashboard',
  handler: getDashboard,
});
