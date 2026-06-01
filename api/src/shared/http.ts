/**
 * Rate-limit-aware fetch wrapper.
 *
 * Retries up to 5 times on HTTP 429, honoring the `Retry-After` header
 * (seconds). Any other non-2xx response throws. Uses the global `fetch`
 * available in Node 20.
 */

const MAX_RETRIES = 5;

export interface FetchJsonOptions extends RequestInit {
  /** Override the default retry count for 429 responses. */
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse Retry-After (seconds or HTTP-date) → milliseconds. */
function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const asInt = Number(header);
    if (!Number.isNaN(asInt)) return asInt * 1000;
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  // Exponential backoff fallback: 1s, 2s, 4s, ...
  return Math.min(2 ** attempt * 1000, 30000);
}

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T> {
  const { maxRetries = MAX_RETRIES, ...init } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);

    if (res.status === 429 && attempt < maxRetries) {
      const waitMs = retryAfterMs(res.headers.get('retry-after'), attempt);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`
      );
    }

    // 204 / empty body guard
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  throw new Error(`Exhausted ${maxRetries} retries (HTTP 429) for ${url}`);
}
