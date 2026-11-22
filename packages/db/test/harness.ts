import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Test harness: creates a throwaway database, applies the Supabase shim and
 * every migration in order, and lets tests run SQL as a specific signed-in
 * user (through RLS), as the anonymous role, or as the server.
 *
 * DATABASE_URL must point at a Postgres server where we may create databases,
 * e.g. postgres://postgres@127.0.0.1:5432/postgres. It is NEVER the Supabase
 * project: these tests create and drop databases.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");
const SHIM = join(import.meta.dirname, "supabase-shim.sql");

export type Actor =
  | { kind: "user"; id: string }
  | { kind: "anon" }
  | { kind: "service" }
  | { kind: "superuser" };

export class TestDb {
  private destroying = false;

  private constructor(
    private readonly admin: pg.Client,
    readonly pool: pg.Pool,
    readonly name: string,
  ) {}

  static async create(): Promise<TestDb> {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see RUNBOOK.md)");
    if (/supabase\.(co|com)/.test(url)) {
      throw new Error("Refusing to run destructive tests against a Supabase host");
    }

    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const name = `glio_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await admin.query(`create database ${name}`);

    const dbUrl = new URL(url);
    dbUrl.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 4 });

    const db = new TestDb(admin, pool, name);
    // Dropping the database at teardown terminates connections that are still
    // closing (57P01). Expected then; anywhere else it is a real failure.
    pool.on("connect", (client) => client.on("error", (err: Error & { code?: string }) => {
      if (!(db.destroying && err.code === "57P01")) throw err;
    }));
    await db.applySql(readFileSync(SHIM, "utf8"));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      await db.applySql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    return db;
  }

  private async applySql(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async destroy(): Promise<void> {
    this.destroying = true;
    await this.pool.end();
    // pool.end() can resolve before every socket has closed; wait for the
    // server to see them gone so the drop below doesn't cut one off.
    for (let i = 0; i < 40; i++) {
      const { rows } = await this.admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [this.name]);
      if (rows[0]?.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.admin.query(`drop database if exists ${this.name} with (force)`);
    await this.admin.end();
  }

  /** Insert a user into auth.users (what Supabase Auth does at sign-up). */
  async createUser(email: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
    return id;
  }

  /**
   * Run `fn` inside one transaction as `actor`, then roll back unless
   * `commit` is true. Errors propagate.
   */
  async as<T>(actor: Actor, fn: (q: Query) => Promise<T>, commit = true): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (actor.kind === "user") {
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: actor.id, role: "authenticated" }),
        ]);
      } else if (actor.kind === "anon") {
        await client.query("set local role anon");
      } else if (actor.kind === "service") {
        await client.query("set local role service_role");
      }
      const q: Query = async (text, params) => (await client.query(text, params)).rows;
      const result = await fn(q);
      await client.query(commit ? "commit" : "rollback");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

export type Query = (text: string, params?: unknown[]) => Promise<Record<string, any>[]>;

export const user = (id: string): Actor => ({ kind: "user", id });
export const anon: Actor = { kind: "anon" };
export const service: Actor = { kind: "service" };
export const superuser: Actor = { kind: "superuser" };
