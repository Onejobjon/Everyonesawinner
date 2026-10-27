/**
 * Owner recovery — reset the owner seat's password WITHOUT loosening the gate.
 *
 *   OWNER_PASSWORD='the-new-secret' bun scripts/set-owner-password.ts [email]
 *
 * Why this exists: the seat is now controlled only by process.env.OWNER_PASSWORD
 * (a forgotten secret would otherwise lock the owner out permanently, because
 * provisioning from a login attempt is exactly the hole we closed). This script
 * is the operator-side door: it writes a scrypt hash straight into the account
 * store, so recovery never involves letting an unauthenticated request create a
 * seat. It does not change the login rule — the secret is still the only way in.
 *
 * Writes to Postgres when DATABASE_URL is set, otherwise to the JSON store
 * (which a redeploy wipes — so run it again after a publish, or set
 * OWNER_PASSWORD and let the normal login path apply it).
 */
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const email = (process.argv[2] || process.env.OWNER_EMAILS?.split(",")[0] || "owner@everyonesawinner.uk")
  .trim()
  .toLowerCase();
const password = process.env.OWNER_PASSWORD || "";
if (password.length < 8) {
  console.error("✗ Set OWNER_PASSWORD to the owner's new password (8+ characters) and re-run:");
  console.error("    OWNER_PASSWORD='…' bun scripts/set-owner-password.ts " + email);
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const passwordHash = scryptSync(password, salt, 64).toString("hex");

if (process.env.DATABASE_URL) {
  const { ensureSchema, query } = await import("../src/server/db-pg.ts");
  await ensureSchema();
  await query(
    `INSERT INTO users (email, name, password_hash, salt, plan, subscription_status)
     VALUES ($1, 'Jon (owner)', $2, $3, 'pro', 'active')
     ON CONFLICT (lower(email)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           salt = EXCLUDED.salt,
           plan = 'pro',
           subscription_status = 'active'`,
    [email, passwordHash, salt],
  );
  console.log(`✓ owner seat reset in Postgres for ${email} (plan pro, active)`);
} else {
  const file = process.env.USERS_FILE || join(process.cwd(), ".run", "users.json");
  mkdirSync(dirname(file), { recursive: true });
  const users = existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "{}") : {};
  users[email] = {
    name: "Jon (owner)",
    email,
    salt,
    passwordHash,
    subscription: true,
    plan: "pro",
    createdAt: users[email]?.createdAt || new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(users, null, 2));
  console.log(`✓ owner seat reset in ${file} for ${email} (plan pro)`);
  console.log("  note: this file is wiped by a deploy — also save OWNER_PASSWORD in Secrets.");
}
console.log("Log in with that password. The OWNER_PASSWORD secret must match it.");
process.exit(0);
