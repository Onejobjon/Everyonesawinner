/**
 * THE POSTGRES DRIVER — the durable one.
 *
 * One table, `eaw_store`, holds every store: (store, key) is the primary key and
 * the value is JSONB. That is a deliberate choice over six typed tables:
 *
 *   • a typed table per store means a migration per shape change, and the shapes
 *     here are app records (an account with a comp, a Stripe event with a note)
 *     that the file driver already stores as documents. Two schemas for one
 *     record is how the SQL path and the file path drift apart — and drifting
 *     apart is exactly the bug this refactor exists to remove.
 *   • one table keeps the interface honest: every method maps to one statement,
 *     and `create()` is a plain PRIMARY KEY conflict, which is the real atomic
 *     guarantee the Stripe ledger needs.
 *
 * `store` is the partition key, so two stores never collide on a key (an email
 * can be both an account key and a comp key).
 *
 * Schema: migrations/005_record_store.sql, applied idempotently by
 * db-pg.ensureSchema() before the first statement. That runs on boot and is
 * safe to run again at any time (CREATE TABLE/INDEX IF NOT EXISTS).
 *
 * FAILURE POLICY: DATABASE_URL set but broken ⇒ THROW. Never fall back to the
 * file. Telling a customer their account was created when nothing was saved is
 * the failure this whole exercise is about.
 */
import { ensureSchema, query } from "../db-pg";
import type { StorageBackend, Store, StoreEntry } from "./types";

/**
 * Turn a JSONB column back into a value.
 *
 * `value::text` normally arrives as the JSON document, but a driver that has
 * already serialised an object on the way in can hand back one more level of
 * quoting. Decoding twice when the first result is a string is cheaper than a
 * whole class of "my account is a string" bug.
 */
function decode<T>(raw: string): T {
  const once = JSON.parse(raw);
  return (typeof once === "string" ? JSON.parse(once) : once) as T;
}

/** The table every store lives in. */
export const STORE_TABLE = "eaw_store";

export class SqlStore<T = unknown> implements Store<T> {
  readonly name: string;
  readonly backend: StorageBackend = "postgres";

  constructor(name: string) {
    this.name = name;
  }

  async get(key: string): Promise<T | null> {
    await ensureSchema();
    const rows = await query<{ value: string }>(
      `SELECT value::text AS value FROM ${STORE_TABLE} WHERE store = $1 AND key = $2`,
      [this.name, key],
    );
    const raw = rows[0]?.value;
    if (raw === undefined || raw === null) return null;
    return decode<T>(raw);
  }

  async put(key: string, value: T): Promise<void> {
    await ensureSchema();
    await query(
      `INSERT INTO ${STORE_TABLE} (store, key, value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (store, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.name, key, value ?? null],
    );
  }

  /**
   * Insert-if-absent, decided by the primary key — the one atomic semantic the
   * Stripe ledger depends on. `ON CONFLICT DO NOTHING ... RETURNING` gives us
   * "did I win the race" in a single round trip, with no read-then-write window
   * for a second delivery to slip through.
   */
  async create(key: string, value: T): Promise<boolean> {
    await ensureSchema();
    const rows = await query<{ key: string }>(
      `INSERT INTO ${STORE_TABLE} (store, key, value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (store, key) DO NOTHING
       RETURNING key`,
      [this.name, key, value ?? null],
    );
    return rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    await ensureSchema();
    const rows = await query<{ key: string }>(
      `DELETE FROM ${STORE_TABLE} WHERE store = $1 AND key = $2 RETURNING key`,
      [this.name, key],
    );
    return rows.length > 0;
  }

  async list(prefix?: string): Promise<StoreEntry<T>[]> {
    await ensureSchema();
    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value::text AS value FROM ${STORE_TABLE}
        WHERE store = $1 AND ($2::text = '' OR key LIKE $2::text || '%')
        ORDER BY created_at ASC, key ASC`,
      [this.name, prefix ?? ""],
    );
    return rows.map((row) => ({ key: row.key, value: decode<T>(row.value) }));
  }
}
