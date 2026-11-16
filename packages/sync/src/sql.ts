import pg from "pg";

export type Rows = Record<string, any>[];
export type Query = (text: string, params?: unknown[]) => Promise<Rows>;

/**
 * The sync runs as the server (service role). It needs plain queries and
 * transactions; this interface lets tests supply a connection that runs as
 * `service_role` inside the test database.
 */
export interface SqlExecutor {
  query: Query;
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
}

/** Production executor over a pg Pool connected with the server's credentials. */
export function pgExecutor(pool: pg.Pool): SqlExecutor {
  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(async (text, params) => (await client.query(text, params)).rows);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
