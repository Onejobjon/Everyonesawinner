import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cwdRunFile } from "./run-dir";
import { store } from "./storage";
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
 * WHERE ACCOUNTS LIVE (2026-11-07): behind the shared record store in
 * src/server/storage/. With DATABASE_URL set they are rows in the `eaw_store`
 * table and survive a redeploy. With it unset they are `.run/users.json`
 * (gitignored) and are LOST on the next publish - the app logs that at startup
 * and reports it on `GET /api/checkout`.
 *
 * Before this the file carried two full implementations - a JSON one and a
 * Postgres one - selected by `if (hasDatabase())` at every call site. They were
 * the two things most likely to drift apart, and the SQL one had never run
 * against a real database.
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
  /**
   * When the CUSTOMER asked us to stop renewing (ISO 8601), if they did.
   *
   * The decision itself lives in `subscriptionStatus`: "canceled_at_period_end"
   * means "stop billing at currentPeriodEnd, keep access until then" (see
   * CANCELED_STATUSES in entitlement.ts). This field only records WHEN they said
   * it, so the account page can say "cancelled on 8 November" — it never decides
   * anything. Absent/null means no cancellation was requested.
   */
  canceledAt?: string | null;
  createdAt: string;
  /**
   * When this account last signed in (ISO 8601). Bookkeeping only - nothing
   * decides access from it. Optional because every account created before
   * 2026-11-07 has none.
   */
  lastLoginAt?: string | null;
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
  /** When the customer asked to stop renewing, if they did (ISO 8601). */
  canceledAt?: string | null;
  /**
   * The Stripe subscription behind this account, if there is one. Not a secret —
   * it is the customer's own reference — and the account page needs it to say
   * whether a real payment provider is involved in a cancellation.
   */
  stripeSubscriptionId?: string | null;
  /** Is this the owner's own seat (never billed, never cancelled)? */
  owner?: boolean;
  token: string;
}

export function usersFile(): string {
  return cwdRunFile(process.env.USERS_FILE, "users.json");
}

/**
 * THE ACCOUNT STORE.
 *
 * Every read and write of an account goes through the shared record store
 * (src/server/storage/): `users.json` — `{ "<email>": StoredUser }`, unchanged —
 * on the file driver, or the `eaw_store` table when DATABASE_URL is set. This
 * file no longer knows which, which is the whole point: before 2026-11-07 it
 * carried two complete implementations (a JSON one and a Postgres one) and they
 * were the two things most likely to drift apart.
 *
 * Keys are lower-cased email addresses — the same normalisation the forms apply,
 * so "Jon@Example.com" and "jon@example.com" are one account.
 */
const usersStore = () => store<StoredUser>("users");

/** One account, or null. */
async function readUser(email: string): Promise<StoredUser | null> {
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean) return null;
  return usersStore().get(clean);
}

/** Write one account. Throws on a failed write — never a quiet success. */
async function writeUser(record: StoredUser): Promise<void> {
  const clean = record.email.trim().toLowerCase();
  await usersStore().put(clean, { ...record, email: clean });
}

/** Create an account only if the address is free. False ⇒ it already existed. */
async function createUser(record: StoredUser): Promise<boolean> {
  const clean = record.email.trim().toLowerCase();
  return usersStore().create(clean, { ...record, email: clean });
}

/** Every account. Only used by the Stripe-id lookup. */
async function allUsers(): Promise<StoredUser[]> {
  const entries = await usersStore().list();
  return entries.map((entry) => entry.value);
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
    canceledAt: record.canceledAt ?? null,
    stripeSubscriptionId: record.stripeSubscriptionId ?? null,
    owner: isOwnerSeat(record.email),
    token: newToken(),
  };
}

/** Create a new account. Throws on invalid input or duplicate email. */
/**
 * Create an account.
 *
 * `createUser` is insert-if-absent, so two simultaneous signups for the same
 * address cannot both succeed — the second gets the same "already exists" error
 * a sequential one does. (The old JSON path read the file, checked, then wrote;
 * a race could produce two accounts.)
 */
async function registerAccount(name: string, email: string, password: string): Promise<PublicUser> {
  const cleanName = (name ?? "").trim();
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const pw = password ?? "";
  if (!cleanName || cleanName.length > 120) throw new Error("A name is required.");
  if (!cleanEmail || cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) {
    throw new Error("A valid email address is required.");
  }
  // Six characters: this is the rule the live signup form has always enforced
  // and the one every existing account was created under.
  if (!pw || pw.length < 6) throw new Error("Password must be at least 6 characters.");

  const owner = isOwnerSeat(cleanEmail);
  // An allow-listed owner address can only be created by whoever holds the
  // server secret — otherwise /api/signup would be a second way to claim the
  // founder's comped Pro seat. Same generic message as a duplicate, so the form
  // reveals nothing about which addresses are owner seats.
  if (owner && !ownerSecretMatches(pw)) {
    throw new Error("An account with that email already exists.");
  }

  const salt = randomBytes(16).toString("hex");
  // A GRANT GIVEN BEFORE SIGNUP APPLIES NOW: the owner comps an address from the
  // panel, the person registers with it, and the free access is on the account
  // from its first second (src/server/comps.ts).
  const granted = await liveComp(cleanEmail);
  const record: StoredUser = {
    name: cleanName,
    email: cleanEmail,
    salt,
    passwordHash: hashPassword(pw, salt),
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
    comp: granted ? compOf(granted) : null,
  };
  if (!(await createUser(record))) {
    throw new Error("An account with that email already exists.");
  }
  return toPublic(record);
}

/** Verify credentials and return the public user. Throws on failure. */
async function authenticateAccount(email: string, password: string): Promise<PublicUser> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const pw = password ?? "";
  let record = await readUser(cleanEmail);

  // The owner seat is controlled by the SERVER-HELD secret and nothing else.
  //  - Secret set: only a password equal to OWNER_PASSWORD gets in, whatever is
  //    in the store; the record is then (re)written to match the secret, so a
  //    stale or wrongly-provisioned record can neither lock the owner out nor let
  //    a stranger in.
  //  - Secret not set: the seat fails CLOSED (401) even if a record exists.
  if (isOwnerSeat(cleanEmail)) {
    if (!ownerSecretMatches(pw)) {
      // Equalise timing so this does not reveal which emails are owner seats.
      hashPassword(pw, dummySalt);
      throw new Error("Invalid email or password.");
    }
    const salt = randomBytes(16).toString("hex");
    record = {
      name: "Jon (owner)",
      email: cleanEmail,
      salt,
      passwordHash: hashPassword(pw, salt),
      plan: "pro",
      subscriptionStatus: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      stripeCustomerId: record?.stripeCustomerId ?? null,
      stripeSubscriptionId: record?.stripeSubscriptionId ?? null,
      createdAt: record?.createdAt || new Date().toISOString(),
    };
    try {
      await writeUser(record);
    } catch (e) {
      console.warn(`[users] could not persist owner seat for ${cleanEmail}: ${String(e)}`);
    }
    return toPublic(record);
  }

  // Always compute a hash even when the record is missing, to avoid a timing
  // side-channel that reveals which emails exist.
  const candidate = Buffer.from(hashPassword(pw, record?.salt || dummySalt), "hex");
  const expected = Buffer.from(record?.passwordHash || "", "hex");
  const match =
    record != null && expected.length === candidate.length && timingSafeEqual(candidate, expected);
  if (!match) throw new Error("Invalid email or password.");
  await updateLastLogin(cleanEmail);
  return toPublic(record!);
}

/** Create an account. Real, server-persisted session token (see sessions.ts). */
export async function registerUser(name: string, email: string, password: string): Promise<PublicUser> {
  const user = await registerAccount(name, email, password);
  return { ...user, token: await issueSession(user.email) };
}

/** Verify credentials and hand back a session token. */
export async function authenticateUser(email: string, password: string): Promise<PublicUser> {
  const user = await authenticateAccount(email, password);
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
  /** When the customer asked to stop renewing (null clears it, e.g. on resume). */
  canceledAt?: string | null;
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

  const record = await readUser(cleanEmail);
  if (!record) return false;
  if (patch.plan !== undefined) record.plan = patch.plan;
  if (patch.status !== undefined) record.subscriptionStatus = patch.status;
  if (patch.currentPeriodEnd !== undefined) record.currentPeriodEnd = patch.currentPeriodEnd;
  if (patch.graceEndsAt !== undefined) record.graceEndsAt = patch.graceEndsAt;
  if (patch.customerId !== undefined) record.stripeCustomerId = patch.customerId;
  if (patch.subscriptionId !== undefined) record.stripeSubscriptionId = patch.subscriptionId;
  if (patch.canceledAt !== undefined) record.canceledAt = patch.canceledAt;
  await writeUser(record); // throws on a failed write - the caller must hear about it
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

  const record = await readUser(cleanEmail);
  if (!record) return false;
  record.comp = comp;
  await writeUser(record); // throws on a failed write - the caller must hear about it
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
  const granted = await liveComp(record.email);
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

  // A scan of every account: the store has no secondary index and this runs only
  // on a Stripe event, which is rare. Deliberately NOT cached - a stale cache
  // here would apply a subscription to the wrong person.
  for (const record of await allUsers()) {
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
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail) return;
  try {
    const record = await readUser(cleanEmail);
    if (!record) return;
    await writeUser({ ...record, lastLoginAt: new Date().toISOString() });
  } catch (e) {
    // Bookkeeping only - a login must never fail because of it.
    console.warn(`[users] could not record the last login for ${cleanEmail}: ${String(e)}`);
  }
}


/** Look up a user without a password (Stripe webhooks, admin checks). */
export async function findByEmail(email: string): Promise<PublicUser | null> {
  const record = await readUser(email);
  return record ? toPublic(await withLedgerComp(record)) : null;
}

