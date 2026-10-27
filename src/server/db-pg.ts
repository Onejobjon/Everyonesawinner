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

function db(): SQL {
  const url = databaseUrl();
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!client) {
    client = new SQL(url, { max: 5, idleTimeout: 20 });
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
