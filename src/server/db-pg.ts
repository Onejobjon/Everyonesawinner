/**
 * Postgres connection + query layer for the account/lead store.
 *
 * Uses Bun's built-in SQL client, which speaks the ordinary Postgres wire
 * protocol, so the SAME code works against a local Postgres, Neon, Supabase or
 * any other managed Postgres. (The older src/db.ts neon-HTTP client only works
 * against Neon's HTTP proxy; the store therefore does not depend on it.)
 *
 * Contract: DATABASE_URL present => Postgres. Present but broken => throw
 * loudly. NEVER silently fall back to the JSON file, or we tell a customer
 * their account was created when nothing was saved.
 */
import { SQL } from "bun";

export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

export function hasDatabase(): boolean {
  return databaseUrl() !== null;
}

let client: SQL | null = null;
let schemaReady: Promise<void> | null = null;

/**
 * Connection options for a DATABASE_URL.
 *
 * Managed Postgres (Neon, Supabase, RDS, Vercel Postgres) refuses unencrypted
 * connections, and Bun refuses to downgrade — it throws "connection is
 * insecure (try using `sslmode=require`)". Requiring TLS whenever the URL does
 * not say otherwise means a connection string that arrives WITHOUT a query
 * string still works, which matters because a secret field can be short and a
 * full Neon URL with `?channel_binding=require&sslmode=require` is long.
 * A local Postgres is left alone so a developer's `postgres://.../localhost`
 * keeps working without a certificate.
 */
export function connectionOptions(url: string): {
  max: number;
  idleTimeout: number;
  tls?: boolean;
} {
  const opts: { max: number; idleTimeout: number; tls?: boolean } = {
    max: 5,
    idleTimeout: 20,
  };
  const hasSslMode = /[?&]sslmode=/i.test(url);
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url);
  if (!hasSslMode && !isLocal) {
    opts.tls = true;
  }
  return opts;
}

function db(): SQL {
  const url = databaseUrl();
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!client) {
    client = new SQL(url, connectionOptions(url));
  }
  return client;
}

/** Run one parameterised statement. Errors propagate — never swallowed. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await db().unsafe(text, params as never[]);
  return rows as unknown as T[];
}

/**
 * Apply migrations/*.sql once per process. Callers await this before their first
 * write so a fresh database cannot fail on a missing table.
 */
export async function ensureSchema(): Promise<void> {
  if (!hasDatabase()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      const dir = `${process.cwd()}/migrations`;
      const files = Array.from(new Bun.Glob("*.sql").scanSync(dir)).sort();
      for (const file of files) {
        const sqlText = await Bun.file(`${dir}/${file}`).text();
        // Strip line comments, then run the statement batch.
        const body = sqlText
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n");
        for (const statement of body.split(";")) {
          const s = statement.trim();
          if (s) await query(s);
        }
      }
    })().catch((e) => {
      schemaReady = null;
      throw new Error(
        `[db] schema bootstrap failed — DATABASE_URL is set but the database is not usable: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }
  return schemaReady;
}
