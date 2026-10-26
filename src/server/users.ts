import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

function toPublic(record: StoredUser): PublicUser {
  return {
    name: record.name,
    email: record.email,
    subscription: record.subscription,
    plan: record.plan,
    token: newToken(),
  };
}

/** Create a new account. Throws on invalid input or duplicate email. */
export function registerUser(name: string, email: string, password: string): PublicUser {
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
  const record: StoredUser = {
    name: cleanName,
    email: cleanEmail,
    salt,
    passwordHash: hashPassword(password, salt),
    subscription: false,
    plan: null,
    createdAt: new Date().toISOString(),
  };
  users[cleanEmail] = record;
  saveUsers(users);
  return toPublic(record);
}

/** Verify credentials and return the public user. Throws on failure. */
export function authenticateUser(email: string, password: string): PublicUser {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  const users = loadUsers();
  const record = users[cleanEmail];
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
