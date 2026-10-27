/**
 * One-command, idempotent database bootstrap:  bun scripts/db-init.ts
 *
 * Applies every migrations/*.sql file in order (all statements are IF NOT
 * EXISTS, so re-running is safe) and prints the resulting table inventory.
 * Run it once after DATABASE_URL is saved — the app also self-bootstraps on
 * first write, this just makes the step explicit and checkable.
 */
process.env.NODE_ENV ||= "production";
const { hasDatabase, databaseUrl, ensureSchema, query } = await import("../src/server/db-pg.ts");

if (!hasDatabase()) {
  console.error("✗ DATABASE_URL is not set. Save the connection string first, then re-run.");
  process.exit(1);
}

const host = (() => {
  try {
    return new URL(databaseUrl()!).host;
  } catch {
    return "(unparseable URL)";
  }
})();

console.log(`→ applying migrations against ${host}`);
await ensureSchema();

const tables = await query<{ table_name: string }>(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
);
const users = await query<{ count: string }>("SELECT count(*)::text AS count FROM users");
const leads = await query<{ count: string }>("SELECT count(*)::text AS count FROM leads");
console.log(`✓ schema ready. tables: ${tables.map((t) => t.table_name).join(", ")}`);
console.log(`✓ users: ${users[0]?.count ?? "?"} rows, leads: ${leads[0]?.count ?? "?"} rows`);
process.exit(0);
