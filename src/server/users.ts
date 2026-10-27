import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ensureSchema, hasDatabase, query } from "./db-pg";
import { issueSession } from "./sessions";

/**
 * Server-side user store. Accounts persist to a JSON file (`.run/users.json`
 * by default, gitignored) so signups/logins survive restarts — the fix for the
 * "accounts were only held in the browser's localStorage" problem. Passwords are
 * scrypt-hashed with a per-user salt (never stored in plaintext).
 *
 * This is the platform-URL store (Bun `serve-static.ts`, durable disk). On the
 * Vercel domain the function filesystem is ephemeral, so production-grade auth
 * there needs a real Postgres `users` table (src/db.ts) once DATABASE_URL is
 * connected — same caveat documented on the leads store.
 */

export interface StoredUser {
  name: string;
  email: string;
  salt: string;
  passwordHash: string;
  subscription: boolean;
  plan: "starter" | "pro" | "annual" | null;
  createdAt: string;
}

/** The user shape returned to the client (never includes the hash/salt). */
export interface PublicUser {
  name: string;
  email: string;
  subscription: boolean;
  plan: "starter" | "pro" | "annual" | null;
  token: string;
}

export function usersFile(): string {
  return process.env.USERS_FILE || join(process.cwd(), ".run", "users.json");
}

function loadUsers(): Record<string, StoredUser> {
  const file = usersFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredUser>) : {};
  } catch {
    return {};
  }
}

function saveUsers(users: Record<string, StoredUser>): void {
  const file = usersFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(users, null, 2));
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Owner seats — comped Pro access with no Stripe subscription.
 *
 * Addresses come from the OWNER_EMAILS environment variable (comma-separated,
 * e.g. "owner@everyonesawinner.uk,someone@else.com"), with the business owner's
 * address as a built-in default so the seat cannot be lost by forgetting to set
 * the variable. This is an allowlist, not a role system: keep it short.
 *
 * The seat is SELF-PROVISIONING (see authenticateUser): if the allow-listed
 * address has no record — which is what happens on every redeploy today, because
 * the JSON store lives on an ephemeral disk — the login request creates it from
 * the password supplied at that moment. We never store a password ourselves and
 * never hardcode one in the repo; the first successful login sets it.
 */
const DEFAULT_OWNER_EMAILS = ["owner@everyonesawinner.uk"];
export function ownerEmails(): string[] {
  const fromEnv = (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([...fromEnv, ...DEFAULT_OWNER_EMAILS]));
}
/**
 * True only when the submitted password equals the SERVER-HELD owner secret
 * (process.env.OWNER_PASSWORD), compared in constant time.
 *
 * This is the gate for owner-seat provisioning. The old gate was
 * `password.length >= 6`, which is no gate at all when there is no record to
 * compare against: after every deploy the store is empty, so any stranger who
 * typed the founder's email with any password became the founder. With no
 * secret set we never provision — the request gets an ordinary 401 instead.
 */
function ownerSecretMatches(password: string | undefined): boolean {
  const secret = process.env.OWNER_PASSWORD;
  if (!secret || !password) return false;
  const candidate = Buffer.from(hashPassword(password, secret), "hex");
  const expected = Buffer.from(hashPassword(secret, secret), "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function isOwnerSeat(email: string): boolean {
  return ownerEmails().includes(email.trim().toLowerCase());
}

function toPublic(record: StoredUser): PublicUser {
  if (isOwnerSeat(record.email)) {
    return {
      name: record.name,
      email: record.email,
      subscription: true,
      plan: "pro",
      token: newToken(),
    };
  }
  return {
    name: record.name,
    email: record.email,
    subscription: record.subscription,
    plan: record.plan,
    token: newToken(),
  };
}

/** Create a new account. Throws on invalid input or duplicate email. */
function registerUserJson(name: string, email: string, password: string): PublicUser {
  const cleanName = (name ?? "").trim();
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanName || cleanName.length > 120) throw new Error("A name is required.");
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) {
    throw new Error("A valid email address is required.");
  }
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");

  const users = loadUsers();
  if (users[cleanEmail]) throw new Error("An account with that email already exists.");

  const salt = randomBytes(16).toString("hex");
  const owner = isOwnerSeat(cleanEmail);
  // An allow-listed owner address can only be created by whoever holds the
  // server secret — otherwise /api/signup would be a second way to claim the
  // founder's comped Pro seat. Same generic message as a duplicate, so the form
  // reveals nothing about which addresses are owner seats.
  if (owner && !ownerSecretMatches(password)) {
    throw new Error("An account with that email already exists.");
  }
  const record: StoredUser = {
    name: cleanName,
    email: cleanEmail,
    salt,
    passwordHash: hashPassword(password, salt),
    // Owner seats are comped Pro: they are not customers and must never be
    // blocked behind a subscription that billing has not built yet.
    subscription: owner,
    plan: owner ? "pro" : null,
    createdAt: new Date().toISOString(),
  };
  users[cleanEmail] = record;
  saveUsers(users);
  return toPublic(record);
}

/** Verify credentials and return the public user. Throws on failure. */
function authenticateUserJson(email: string, password: string): PublicUser {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const users = loadUsers();
  let record = users[cleanEmail];
  // The owner seat is controlled by the SERVER-HELD secret and nothing else.
  //  - Secret set: only a password equal to OWNER_PASSWORD gets in, whatever is
  //    in the store; the record is then (re)written to match the secret, so a
  //    stale or wrongly-provisioned row can neither lock the owner out nor let
  //    a stranger in.
  //  - Secret not set: the seat fails CLOSED (401) even if a row exists.
  if (isOwnerSeat(cleanEmail)) {
    if (!ownerSecretMatches(password)) {
      // Equalise timing so this does not reveal which emails are owner seats.
      hashPassword(password || "", "00000000000000000000000000000000");
      throw new Error("Invalid email or password.");
    }
    const salt = randomBytes(16).toString("hex");
    record = {
      name: "Jon (owner)",
      email: cleanEmail,
      salt,
      passwordHash: hashPassword(password, salt),
      subscription: true,
      plan: "pro",
      createdAt: record?.createdAt || new Date().toISOString(),
    };
    users[cleanEmail] = record;
    try {
      saveUsers(users);
    } catch (e) {
      console.warn(`[users] could not persist owner seat for ${cleanEmail}: ${String(e)}`);
    }
    return toPublic(record);
  }


  // Always compute a hash even when the record is missing, to avoid a timing
  // side-channel that reveals which emails exist.
  const dummySalt = "00000000000000000000000000000000";
  const candidate = hashPassword(password || "", record?.salt || dummySalt);
  const expected = record?.passwordHash || "";
  const candidateBuf = Buffer.from(candidate, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const match =
    record != null &&
    expectedBuf.length === candidateBuf.length &&
    timingSafeEqual(candidateBuf, expectedBuf);
  if (!match) throw new Error("Invalid email or password.");
  return toPublic(record!);
}


/* ------------------------------------------------------------------ *
 * Backend switch: DATABASE_URL present => Postgres, absent => JSON file.
 *
 * The JSON path above is kept exactly as it was (it is what runs on the
 * platform today). The Postgres path is the durable one: it survives a
 * redeploy. Neither path ever returns success after a failed write.
 * ------------------------------------------------------------------ */

let warnedNonDurable = false;
function warnNonDurableOnce(): void {
  if (warnedNonDurable) return;
  warnedNonDurable = true;
  console.warn(
    "[users] DATABASE_URL is not set — accounts are stored in a JSON file that does NOT survive a redeploy. Set DATABASE_URL to make accounts durable.",
  );
}

interface UserRow {
  email: string;
  name: string;
  password_hash: string;
  salt: string;
  plan: "starter" | "pro" | "annual" | null;
  subscription_status: string | null;
}

function rowToStored(row: UserRow): StoredUser {
  return {
    name: row.name,
    email: row.email,
    salt: row.salt,
    passwordHash: row.password_hash,
    subscription: isOwnerSeat(row.email) || row.subscription_status === "active" || row.subscription_status === "trialing",
    plan: isOwnerSeat(row.email) ? "pro" : row.plan,
    createdAt: new Date().toISOString(),
  };
}

async function registerUserDb(name: string, email: string, password: string): Promise<PublicUser> {
  await ensureSchema();
  const cleanName = (name ?? "").trim();
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const pw = password ?? "";
  if (!cleanName || cleanName.length > 120) throw new Error("A name is required.");
  if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) {
    throw new Error("A valid email address is required.");
  }
  if (pw.length < 8) throw new Error("Password must be at least 8 characters.");
  if (isOwnerSeat(cleanEmail) && !ownerSecretMatches(pw)) {
    throw new Error("An account with that email already exists.");
  }
  const salt = randomBytes(16).toString("hex");
  const rows = await query<UserRow>(
    `INSERT INTO users (email, name, password_hash, salt, plan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING email, name, password_hash, salt, plan, subscription_status`,
    [cleanEmail, cleanName, hashPassword(pw, salt), salt, isOwnerSeat(cleanEmail) ? "pro" : null],
  );
  if (rows.length === 0) throw new Error("An account with that email already exists.");
  return toPublic(rowToStored(rows[0]!));
}

async function authenticateUserDb(email: string, password: string): Promise<PublicUser> {
  await ensureSchema();
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const pw = password ?? "";
  let rows = await query<UserRow>(
    `SELECT email, name, password_hash, salt, plan, subscription_status FROM users WHERE lower(email) = $1`,
    [cleanEmail],
  );
  // Owner seat: controlled by the server secret alone (same rule as the JSON
  // store). Secret set + matching password => create/refresh the row as Pro.
  // Secret missing or password different => ordinary 401, no row touched.
  if (cleanEmail && isOwnerSeat(cleanEmail) && ownerSecretMatches(pw)) {
    const salt = randomBytes(16).toString("hex");
    rows = await query<UserRow>(
      `INSERT INTO users (email, name, password_hash, salt, plan)
       VALUES ($1, $2, $3, $4, 'pro')
       ON CONFLICT (lower(email)) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             salt = EXCLUDED.salt,
             plan = 'pro',
             subscription_status = COALESCE(users.subscription_status, 'active')
       RETURNING email, name, password_hash, salt, plan, subscription_status`,
      [cleanEmail, "Jon (owner)", hashPassword(pw, salt), salt],
    );
    console.log(`[users] owner seat refreshed in Postgres for ${cleanEmail}`);
  } else if (cleanEmail && isOwnerSeat(cleanEmail)) {
    // Fail closed: an owner address with no valid secret is never accepted,
    // even if a row exists.
    hashPassword(pw || "", "00000000000000000000000000000000");
    throw new Error("Invalid email or password.");
  }
  const record = rows[0];
  const dummySalt = "00000000000000000000000000000000";
  const candidate = Buffer.from(hashPassword(pw, record?.salt || dummySalt), "hex");
  const expected = Buffer.from(record?.password_hash || "", "hex");
  const match =
    record != null && expected.length === candidate.length && timingSafeEqual(candidate, expected);
  if (!match) throw new Error("Invalid email or password.");
  await query(`UPDATE users SET last_login_at = now() WHERE lower(email) = $1`, [cleanEmail]);
  return toPublic(rowToStored(record));
}

/** Create an account. Postgres when DATABASE_URL is set, JSON file otherwise. */
export async function registerUser(name: string, email: string, password: string): Promise<PublicUser> {
  const user = hasDatabase()
    ? await registerUserDb(name, email, password)
    : (warnNonDurableOnce(), registerUserJson(name, email, password));
  // Real, server-persisted session token (see src/server/sessions.ts).
  return { ...user, token: await issueSession(user.email) };
}

/** Verify credentials. Postgres when DATABASE_URL is set, JSON file otherwise. */
export async function authenticateUser(email: string, password: string): Promise<PublicUser> {
  const user = hasDatabase()
    ? await authenticateUserDb(email, password)
    : (warnNonDurableOnce(), authenticateUserJson(email, password));
  // Real, server-persisted session token (see src/server/sessions.ts).
  return { ...user, token: await issueSession(user.email) };
}

/** Record a plan change (Stripe webhook / manual comp). */
export async function setPlan(
  email: string,
  plan: "starter" | "pro" | "annual" | null,
  subscriptionStatus: string | null = plan ? "active" : null,
  stripeIds: { customerId?: string | null; subscriptionId?: string | null } = {},
): Promise<void> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (hasDatabase()) {
    await ensureSchema();
    await query(
      `UPDATE users SET plan = $2, subscription_status = $3,
         stripe_customer_id = COALESCE($4, stripe_customer_id),
         stripe_subscription_id = COALESCE($5, stripe_subscription_id)
       WHERE lower(email) = $1`,
      [cleanEmail, plan, subscriptionStatus, stripeIds.customerId ?? null, stripeIds.subscriptionId ?? null],
    );
    return;
  }
  warnNonDurableOnce();
  const users = loadUsers();
  const record = users[cleanEmail];
  if (!record) return;
  record.plan = plan;
  record.subscription = subscriptionStatus === "active" || subscriptionStatus === "trialing";
  users[cleanEmail] = record;
  saveUsers(users);
}

/** Mark a login timestamp (Postgres only; the JSON store keeps createdAt). */
export async function updateLastLogin(email: string): Promise<void> {
  if (!hasDatabase()) return;
  await ensureSchema();
  await query(`UPDATE users SET last_login_at = now() WHERE lower(email) = $1`, [
    (email ?? "").trim().toLowerCase(),
  ]);
}

/** Look up a user without a password (Stripe webhooks, admin checks). */
export async function findByEmail(email: string): Promise<PublicUser | null> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (hasDatabase()) {
    await ensureSchema();
    const rows = await query<UserRow>(
      `SELECT email, name, password_hash, salt, plan, subscription_status FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    return rows[0] ? toPublic(rowToStored(rows[0])) : null;
  }
  const users = loadUsers();
  const record = users[cleanEmail];
  return record ? toPublic(record) : null;
}
