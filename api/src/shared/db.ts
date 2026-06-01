import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getSecret } from './secrets';

/**
 * Singleton `pg` Pool. The connection string is resolved once at cold start:
 *   - locally from DB_CONNECTION_STRING
 *   - in Azure from the Key Vault secret `db-connection-string` (Managed Identity)
 *
 * Keep the app layer thin: this module only exposes `query` and
 * `withTransaction`. All business logic lives in SQL views/functions.
 */

let poolPromise: Promise<Pool> | undefined;

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const connectionString = await getSecret('db-connection-string');
      const pool = new Pool({
        connectionString,
        // Azure PostgreSQL Flexible Server requires TLS. We don't pin the CA
        // here (Consumption plan, MVP); reject-unauthorized stays off so the
        // managed cert chain doesn't break the connection.
        ssl: connectionString.includes('sslmode=disable')
          ? undefined
          : { rejectUnauthorized: false },
        max: 4, // Consumption plan: keep the pool small
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      return pool;
    })();
  }
  return poolPromise;
}

/** Run a parameterized query. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const pool = await getPool();
  return pool.query<T>(sql, params);
}

/** Run `fn` inside a transaction; commits on success, rolls back on throw. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
