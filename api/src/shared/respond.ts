import { HttpRequest, HttpResponseInit } from '@azure/functions';

/**
 * Shared helpers for the read API. Endpoints stay thin: they SELECT from a
 * view/function and return JSON. CORS is restricted to the SWA origin
 * (ALLOWED_ORIGIN). Auth relies on Static Web Apps forwarding the
 * `x-ms-client-principal` header — we require its presence in production.
 */

function corsHeaders(): Record<string, string> {
  const origin = process.env.ALLOWED_ORIGIN ?? '*';
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, x-ms-client-principal',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

export function json(body: unknown, status = 200): HttpResponseInit {
  return { status, headers: corsHeaders(), jsonBody: body };
}

export function error(message: string, status = 500): HttpResponseInit {
  return { status, headers: corsHeaders(), jsonBody: { error: message } };
}

/**
 * Returns true when the caller is authenticated. SWA injects
 * `x-ms-client-principal` for signed-in users. When REQUIRE_AUTH !== 'true'
 * (local dev) we allow anonymous access.
 */
export function isAuthenticated(req: HttpRequest): boolean {
  if (process.env.REQUIRE_AUTH !== 'true') return true;
  return Boolean(req.headers.get('x-ms-client-principal'));
}
