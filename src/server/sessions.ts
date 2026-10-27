/**
 * Server-issued session tokens.
 *
 * Before this, `toPublic()` minted a fresh random token on every response and
 * never stored it, so nothing on the server could tell a real login from a
 * hand-written localStorage object containing `token: "deadbeef"`. Now a token
 * is issued at login/signup, PERSISTED server-side, and every paywall decision
 * comes from resolving it (`GET /api/me`) — never from the browser's copy.
 *
 * Storage follows the same switch as the account store: Postgres when
 * DATABASE_URL is set, a JSON file otherwise (which does not survive a
 * redeploy — sessions then expire early rather than grant access wrongly).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureSchema, hasDatabase, query } from "./db-pg";

/** 30 days. Long enough to be usable, short enough that a leaked token dies. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionsFile(): string {
  return process.env.SESSIONS_FILE || join(process.cwd(), ".run", "sessions.json");
}

interface SessionRecord {
  token: string;
  email: string;
  expiresAt: string;
}

function loadSessions(): Record<string, SessionRecord> {
  const file = sessionsFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, SessionRecord>) : {};
  } catch {
    return {};
  }
}

function saveSessions(sessions: Record<string, SessionRecord>): void {
  const file = sessionsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sessions, null, 2));
}

/** Mint and persist a token for an account. Throws if it cannot be persisted —
 *  a session we cannot verify later must not be handed out. */
export async function issueSession(email: string): Promise<string> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail) throw new Error("Cannot issue a session without an account.");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  if (hasDatabase()) {
    await ensureSchema();
    await query(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, $3)`, [
      token,
      cleanEmail,
      expiresAt,
    ]);
    return token;
  }
  const sessions = loadSessions();
  sessions[token] = { token, email: cleanEmail, expiresAt };
  saveSessions(sessions);
  return token;
}

/** Resolve a token to its account email, or null if unknown/expired. */
export async function resolveSession(token: string): Promise<{ email: string } | null> {
  const clean = (token ?? "").trim();
  if (!clean || clean.length < 32) return null;
  if (hasDatabase()) {
    await ensureSchema();
    const rows = await query<{ email: string }>(
      `SELECT email FROM sessions WHERE token = $1 AND expires_at > now()`,
      [clean],
    );
    return rows[0] ? { email: rows[0].email } : null;
  }
  const sessions = loadSessions();
  const record = sessions[clean];
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    delete sessions[clean];
    try {
      saveSessions(sessions);
    } catch {
      /* best effort */
    }
    return null;
  }
  return { email: record.email };
}

/** Drop a token (logout). Best effort — never throws at the caller. */
export async function revokeSession(token: string): Promise<void> {
  const clean = (token ?? "").trim();
  if (!clean) return;
  try {
    if (hasDatabase()) {
      await ensureSchema();
      await query(`DELETE FROM sessions WHERE token = $1`, [clean]);
      return;
    }
    const sessions = loadSessions();
    if (sessions[clean]) {
      delete sessions[clean];
      saveSessions(sessions);
    }
  } catch (e) {
    console.warn(`[sessions] revoke failed: ${String(e)}`);
  }
}
