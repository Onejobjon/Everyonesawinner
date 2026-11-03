import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ensureSchema, hasDatabase, query } from "./db-pg";
import { issueSession } from "./sessions";
import {
  compGrants,
  isEntitled,
  isKnownPlan,
  type CompState,
  type Plan,
  type SubscriptionState,
} from "./entitlement";
import { compOf, liveComp } from "./comps";

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

/**
 * One account as stored. `subscription` is deliberately GONE: access is no
 * longer a boolean somebody sets, it is derived by isEntitled() (see
 * src/server/entitlement.ts) from the plan, the Stripe status and the date the
 * paid period ends. A boolean with no end date was how one payment bought Pro
 * for ever.
 */
export interface StoredUser {
  name: string;
  email: string;
  salt: string;
  passwordHash: string;
  plan: Plan | null;
  /** Stripe subscription status: active | trialing | past_due | canceled | … */
  subscriptionStatus: string | null;
  /** When the period the customer has paid for ends (ISO 8601). */
  currentPeriodEnd: string | null;
  /** When the failed-payment grace window closes (ISO 8601). */
  graceEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
  /**
   * A FREE-ACCESS GRANT — this person uses the site without paying (a trialist,
   * a reviewer, a friend). Written by the owner's grant panel (src/server/comps.ts)
   * and decided by compGrants() in entitlement.ts: dated, or explicitly undated,
   * and revocable. Absent means no comp — it never means "no end date".
   */
  comp?: CompState | null;
}

/**
 * The user shape returned to the client (never includes the hash/salt).
 *
 * `entitled` is THE answer to "may this account use the paid tools", computed by
 * the one rule in entitlement.ts. The browser renders it and never recomputes
 * it from a local flag — a local boolean is a second opinion, and two opinions
 * is how a customer ends up paying for a locked door.
 */
export interface PublicUser {
  name: string;
  email: string;
  entitled: boolean;
  plan: Plan | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  /** The free-access grant behind this session, if any — so the page can say
   *  "free access until <date>" instead of showing a price. */
  comp: CompState | null;
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

// Constant salt used ONLY to burn the same time as a real hash when a login must
// fail, so response timing does not reveal which addresses have accounts.
const dummySalt = "00000000000000000000000000000000";

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

/** The entitlement inputs for one stored record (owner seat included). */
export function stateOf(record: StoredUser, nowMs: number = Date.now()): SubscriptionState {
  const ownerSeat = isOwnerSeat(record.email);
  const comp = record.comp ?? null;
  // A live grant speaks for the account: it sets the plan the tools read, so a
  // comped Pro unlocks the Pro-only pages even with no subscription at all.
  // An EXPIRED or revoked grant grants nothing and is not allowed to make the
  // account look like a subscriber either.
  const compLive = compGrants(comp, nowMs);
  return {
    plan: ownerSeat ? "pro" : compLive && comp ? comp.plan : record.plan ?? null,
    status: ownerSeat ? "active" : compLive ? "comp" : record.subscriptionStatus ?? null,
    currentPeriodEnd:
      compLive && comp ? (comp.permanent === true ? null : comp.endsAt) : record.currentPeriodEnd ?? null,
    graceEndsAt: record.graceEndsAt ?? null,
    ownerSeat,
    comp,
  };
}

function toPublic(record: StoredUser): PublicUser {
  const state = stateOf(record);
  return {
    name: record.name,
    email: record.email,
    entitled: isEntitled(state),
    plan: state.plan,
    subscriptionStatus: state.status,
    currentPeriodEnd: state.currentPeriodEnd,
    graceEndsAt: state.graceEndsAt,
    comp: state.comp ?? null,
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
  const granted = liveComp(cleanEmail);
  const pending: CompState | null = granted ? compOf(granted) : null;
  const record: StoredUser = {
    name: cleanName,
    email: cleanEmail,
    salt,
    passwordHash: hashPassword(password, salt),
    // Owner seats are comped Pro: they are not customers and must never be
    // blocked behind a subscription that billing has not built yet. The comp is
    // expressed by stateOf() (ownerSeat), not by a stored boolean.
    plan: owner ? "pro" : null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date().toISOString(),
    // A GRANT GIVEN BEFORE SIGNUP APPLIES NOW: the owner comps an address from
    // the panel, the person registers with it, and the free access is on the
    // account from its first second (src/server/comps.ts).
    comp: pending,
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
      hashPassword(password || "", dummySalt);
      throw new Error("Invalid email or password.");
    }
    const salt = randomBytes(16).toString("hex");
    record = {
      name: "Jon (owner)",
      email: cleanEmail,
      salt,
      passwordHash: hashPassword(password, salt),
      plan: "pro",
      subscriptionStatus: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      stripeCustomerId: record?.stripeCustomerId ?? null,
      stripeSubscriptionId: record?.stripeSubscriptionId ?? null,
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
  plan: Plan | null;
  subscription_status: string | null;
  current_period_end: string | Date | null;
  grace_ends_at: string | Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** Free-access grant columns (migrations/004_free_access_grants.sql). */
  comp_plan?: string | null;
  comp_ends_at?: string | Date | null;
  comp_permanent?: boolean | null;
  comp_note?: string | null;
  comp_granted_by?: string | null;
  comp_granted_at?: string | Date | null;
}

/** Postgres timestamps arrive as Date or string depending on the driver. */
function isoOrNull(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function rowToStored(row: UserRow): StoredUser {
  const comp: CompState | null = isKnownPlan(row.comp_plan)
    ? {
        plan: row.comp_plan,
        endsAt: isoOrNull(row.comp_ends_at),
        permanent: row.comp_permanent === true,
        note: row.comp_note ?? undefined,
        grantedBy: row.comp_granted_by ?? undefined,
        grantedAt: isoOrNull(row.comp_granted_at) ?? undefined,
      }
    : null;
  return {
    name: row.name,
    email: row.email,
    salt: row.salt,
    passwordHash: row.password_hash,
    plan: row.plan,
    subscriptionStatus: row.subscription_status,
    currentPeriodEnd: isoOrNull(row.current_period_end),
    graceEndsAt: isoOrNull(row.grace_ends_at),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    createdAt: new Date().toISOString(),
    comp,
  };
}

/** The columns rowToStored() needs — keep in step with the SELECTs below. */
const USER_COLUMNS =
  "email, name, password_hash, salt, plan, subscription_status, current_period_end, grace_ends_at, stripe_customer_id, stripe_subscription_id, comp_plan, comp_ends_at, comp_permanent, comp_note, comp_granted_by, comp_granted_at";

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
     RETURNING ${USER_COLUMNS}`,
    [cleanEmail, cleanName, hashPassword(pw, salt), salt, isOwnerSeat(cleanEmail) ? "pro" : null],
  );
  if (rows.length === 0) throw new Error("An account with that email already exists.");
  const stored = rowToStored(rows[0]!);
  // A grant given before signup applies now — same rule as the JSON path.
  const granted = liveComp(cleanEmail);
  if (granted) {
    const comp = compOf(granted);
    await setComp(cleanEmail, comp);
    stored.comp = comp;
  }
  return toPublic(stored);
}

async function authenticateUserDb(email: string, password: string): Promise<PublicUser> {
  await ensureSchema();
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const pw = password ?? "";
  let rows = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`,
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
       RETURNING ${USER_COLUMNS}`,
      [cleanEmail, "Jon (owner)", hashPassword(pw, salt), salt],
    );
    console.log(`[users] owner seat refreshed in Postgres for ${cleanEmail}`);
  } else if (cleanEmail && isOwnerSeat(cleanEmail)) {
    // Fail closed: an owner address with no valid secret is never accepted,
    // even if a row exists.
    hashPassword(pw || "", dummySalt);
    throw new Error("Invalid email or password.");
  }
  const record = rows[0];
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
  // A free-access grant given before signup — or one the record does not carry
  // yet — applies at sign-in too, not only at registration.
  let effective = user;
  try {
    effective = (await findByEmail(user.email)) ?? user;
  } catch (e) {
    console.warn(`[users] could not apply free-access grants at sign-in: ${String(e)}`);
  }
  // Real, server-persisted session token (see src/server/sessions.ts).
  return { ...effective, token: await issueSession(user.email) };
}

/**
 * A patch to one account's billing state.
 *
 * `undefined` means "leave this field alone"; `null` means "clear it". That
 * distinction is the whole point: a Stripe event that carries no period end must
 * not wipe the period end we already know, and a cancellation must be able to
 * clear it deliberately.
 */
export interface SubscriptionPatch {
  plan?: Plan | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  graceEndsAt?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
}

/**
 * Write billing state for one account.
 *
 * Returns TRUE when the account was updated, FALSE when there is no account
 * with that email. A write that FAILS THROWS — never a quiet success. (Before
 * 2026-11-02 the JSON path did `if (!record) return;` and logged success
 * regardless: a payer whose Stripe email differed from their account email paid
 * and got nothing, and nothing anywhere said so.)
 */
export async function updateSubscription(
  email: string,
  patch: SubscriptionPatch,
): Promise<boolean> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail) return false;

  if (hasDatabase()) {
    await ensureSchema();
    const sets: string[] = [];
    const params: unknown[] = [cleanEmail];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.plan !== undefined) put("plan", patch.plan);
    if (patch.status !== undefined) put("subscription_status", patch.status);
    if (patch.currentPeriodEnd !== undefined) put("current_period_end", patch.currentPeriodEnd);
    if (patch.graceEndsAt !== undefined) put("grace_ends_at", patch.graceEndsAt);
    if (patch.customerId !== undefined) put("stripe_customer_id", patch.customerId);
    if (patch.subscriptionId !== undefined) put("stripe_subscription_id", patch.subscriptionId);
    if (sets.length === 0) return true; // nothing to write
    const rows = await query<{ email: string }>(
      `UPDATE users SET ${sets.join(", ")} WHERE lower(email) = $1 RETURNING email`,
      params,
    );
    return rows.length > 0;
  }

  warnNonDurableOnce();
  const users = loadUsers();
  const record = users[cleanEmail];
  if (!record) return false;
  if (patch.plan !== undefined) record.plan = patch.plan;
  if (patch.status !== undefined) record.subscriptionStatus = patch.status;
  if (patch.currentPeriodEnd !== undefined) record.currentPeriodEnd = patch.currentPeriodEnd;
  if (patch.graceEndsAt !== undefined) record.graceEndsAt = patch.graceEndsAt;
  if (patch.customerId !== undefined) record.stripeCustomerId = patch.customerId;
  if (patch.subscriptionId !== undefined) record.stripeSubscriptionId = patch.subscriptionId;
  users[cleanEmail] = record;
  saveUsers(users); // throws on a failed write — the caller must hear about it
  return true;
}

/**
 * Write (or clear, with `null`) the free-access grant on one account.
 *
 * This is the account-record half of a comp; the owner's list lives in
 * src/server/comps.ts and both are written together by the grant endpoints. The
 * grant is stored as given — it is NOT re-dated here, so revoking or shortening
 * a grant is immediate. `stateOf()` decides whether it grants anything.
 *
 * Returns TRUE when an account was updated, FALSE when there is no account with
 * that email (the grant then waits in the ledger for signup).
 */
export async function setComp(email: string, comp: CompState | null): Promise<boolean> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail) return false;

  if (hasDatabase()) {
    await ensureSchema();
    const rows = await query<{ email: string }>(
      `UPDATE users
          SET comp_plan = $2, comp_ends_at = $3, comp_permanent = $4,
              comp_note = $5, comp_granted_by = $6, comp_granted_at = $7
        WHERE lower(email) = $1
        RETURNING email`,
      [
        cleanEmail,
        comp?.plan ?? null,
        comp?.endsAt ?? null,
        comp?.permanent === true,
        comp?.note ?? null,
        comp?.grantedBy ?? null,
        comp?.grantedAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  warnNonDurableOnce();
  const users = loadUsers();
  const record = users[cleanEmail];
  if (!record) return false;
  record.comp = comp;
  users[cleanEmail] = record;
  saveUsers(users); // throws on a failed write — the caller must hear about it
  return true;
}

/**
 * Copy a grant from the owner's ledger onto the account record when the record
 * does not already carry it.
 *
 * WHY: a grant can be given before the account exists, and the ledger is the
 * list the owner sees. This is what makes "comp an address, they sign up, they
 * are in" true on every path (signup, login, /api/me, the server-side gates)
 * without any of them having to know about comps. It only ever ADDS a live
 * grant; it never removes one, so a revoke is never undone by a stale ledger.
 */
async function withLedgerComp(record: StoredUser): Promise<StoredUser> {
  const granted = liveComp(record.email);
  if (!granted) return record;
  if (record.comp && record.comp.grantedAt === granted.grantedAt) return record;
  const comp = compOf(granted);
  try {
    await setComp(record.email, comp);
  } catch (e) {
    // The write failed, but the grant is real: this request is still entitled
    // (the copy below is what entitlement reads). The next lookup retries.
    console.warn(`[users] could not store the free-access grant for ${record.email}: ${String(e)}`);
  }
  return { ...record, comp };
}

/**
 * Find the account a Stripe object belongs to, by the ids we stored.
 *
 * WHY: Stripe does not put our customer's email on a subscription object, so
 * every `customer.subscription.*` event was being ignored (the handler looked
 * for `metadata.email` and gave up). The stored Stripe customer id is the link
 * that always exists once checkout has completed.
 */
export async function findEmailByStripeIds(ids: {
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<string | null> {
  const customerId = ids.customerId || null;
  const subscriptionId = ids.subscriptionId || null;
  if (!customerId && !subscriptionId) return null;

  if (hasDatabase()) {
    await ensureSchema();
    const rows = await query<{ email: string }>(
      `SELECT email FROM users
        WHERE ($1::text IS NOT NULL AND stripe_customer_id = $1)
           OR ($2::text IS NOT NULL AND stripe_subscription_id = $2)
        LIMIT 1`,
      [customerId, subscriptionId],
    );
    return rows[0]?.email ?? null;
  }

  const users = loadUsers();
  for (const record of Object.values(users)) {
    if (customerId && record.stripeCustomerId === customerId) return record.email;
    if (subscriptionId && record.stripeSubscriptionId === subscriptionId) return record.email;
  }
  return null;
}

/** A manual comp with no end date given lasts this long. */
const MANUAL_COMP_DAYS = 30;

/**
 * Record a plan change by hand (a comp, a fix, a test fixture).
 *
 * Stripe events do NOT come through here — they use updateSubscription(), which
 * carries the real period end from the event. A hand-set plan has no Stripe
 * period to quote, so unless the caller supplies one it grants MANUAL_COMP_DAYS
 * from now: an account with a plan and no period end is not entitled under
 * entitlement.ts, and a comp that silently locks the owner out of his own tools
 * would be its own bug.
 *
 * Returns true when an account was updated, false when there is none.
 */
export async function setPlan(
  email: string,
  plan: Plan | null,
  subscriptionStatus: string | null = plan ? "active" : null,
  opts: {
    customerId?: string | null;
    subscriptionId?: string | null;
    currentPeriodEnd?: string | null;
  } = {},
): Promise<boolean> {
  if (plan == null) {
    return updateSubscription(email, {
      plan: null,
      status: subscriptionStatus,
      currentPeriodEnd: null,
      graceEndsAt: null,
    });
  }
  const periodEnd =
    opts.currentPeriodEnd ??
    new Date(Date.now() + MANUAL_COMP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return updateSubscription(email, {
    plan,
    status: subscriptionStatus,
    currentPeriodEnd: periodEnd,
    graceEndsAt: null,
    ...(opts.customerId !== undefined ? { customerId: opts.customerId } : {}),
    ...(opts.subscriptionId !== undefined ? { subscriptionId: opts.subscriptionId } : {}),
  });
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
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    return rows[0] ? toPublic(await withLedgerComp(rowToStored(rows[0]))) : null;
  }
  const users = loadUsers();
  const record = users[cleanEmail];
  return record ? toPublic(await withLedgerComp(record)) : null;
}
