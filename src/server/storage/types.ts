/**
 * THE STORAGE INTERFACE — one shape every persisted customer record goes through.
 *
 * WHY (2026-11-07): accounts, sessions, the Stripe event ledger, comps, leads and
 * the click log were plain files on the hosting disk, and a redeploy replaces
 * that disk. Proven, not inferred: an account created on the live site could not
 * be found after the next publish. That is a hard blocker in front of checkout —
 * the first paying customer would lose their login at the next deploy.
 *
 * The fix is deliberately NOT a general database API. It is the smallest shape
 * these stores actually need: read one record, write one record, insert one
 * record ONLY IF IT IS ABSENT, delete one record, list records by key prefix.
 * Anything more (queries, joins, transactions, indexes) would be a promise the
 * file driver cannot keep, and a promise the file driver cannot keep is how a
 * "database-ready" refactor turns into a lie.
 *
 * ── WHY `create()` IS IN THE INTERFACE ──────────────────────────────────────
 * The Stripe event ledger's whole job is idempotency: an event id must be
 * RESERVED before the handler runs, so two deliveries arriving at the same
 * moment cannot both apply. That is a compare-and-set on "does this key exist",
 * and it is the one atomic semantic the stores depend on. In Postgres it is a
 * PRIMARY KEY; in the file driver it is an exclusive lock around a
 * read-modify-write. `put()` is deliberately last-writer-wins, which is all any
 * other store needs (a subscription update overwrites absolute state).
 *
 * ── WHY THERE IS NO compareAndSet(rev) ─────────────────────────────────────
 * Because nothing uses it. Every write in this app sets absolute state — a
 * status, a period end, a plan, a grant — and the ledger needs "insert once",
 * not "update if unchanged since I read it". Adding revision numbers would be
 * inventing a concurrency model no caller has asked for.
 *
 * Keys are opaque strings, chosen by each store (email, session token, Stripe
 * event id, click timestamp). Values are JSON-serialisable documents.
 */

/** One stored record. */
export interface StoreEntry<T = unknown> {
  key: string;
  value: T;
}

/** Which driver is behind a store. Reported so the app can say what it is on. */
export type StorageBackend = "file" | "postgres";

export interface Store<T = unknown> {
  /** The store's name, e.g. "users". Also the SQL partition key. */
  readonly name: string;
  /** Which driver is serving this store right now. */
  readonly backend: StorageBackend;

  /** The record at `key`, or null. Never throws for "absent". */
  get(key: string): Promise<T | null>;

  /** Write `key`, replacing anything already there (last writer wins). */
  put(key: string, value: T): Promise<void>;

  /**
   * Insert `key` ONLY if it does not already exist.
   *
   * Returns true when this call created the record, false when it was already
   * there. MUST be atomic: this is what stops a Stripe event being applied
   * twice, and what stops two simultaneous signups both creating an account.
   */
  create(key: string, value: T): Promise<boolean>;

  /** Remove `key`. Returns true when a record was there to remove. */
  delete(key: string): Promise<boolean>;

  /**
   * Every record whose key starts with `prefix` (all of them when omitted).
   * Ordered oldest-first: insertion order for the file driver, creation order
   * for Postgres. Both drivers keep it, so the ledger's "keep the last N" prune
   * and the click log's "show me recent clicks" behave the same either way.
   */
  list(prefix?: string): Promise<StoreEntry<T>[]>;
}
