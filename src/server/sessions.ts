/**
 * SERVER-SIDE SESSION TOKENS.
 *
 * A token is only accepted if it is stored here and has not expired. The paywall
 * asks the server (`GET /api/me`) with the token, so a hand-written localStorage
 * session with an invented token resolves to nothing and gets the subscribe
 * screen instead of the Pro tools.
 *
 * Storage is the shared record store (src/server/storage/): `sessions.json` on
 * the file driver — `{ "<token>": { token, email, expiresAt } }`, unchanged —
 * or the `eaw_store` table when DATABASE_URL is set. Nothing here knows which.
 */
import { randomBytes } from "node:crypto";
import { cwdRunFile } from "./run-dir";
import { store } from "./storage";

/** 30 days. Long enough to be usable, short enough that a leaked token dies. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionsFile(): string {
  return cwdRunFile(process.env.SESSIONS_FILE, "sessions.json");
}

interface SessionRecord {
  token: string;
  email: string;
  expiresAt: string;
}

const sessions = () => store<SessionRecord>("sessions");

/** Mint and persist a token for an account. Throws if it cannot be persisted —
 *  a session we cannot verify later must not be handed out. */
export async function issueSession(email: string): Promise<string> {
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail) throw new Error("Cannot issue a session without an account.");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  await sessions().put(token, { token, email: cleanEmail, expiresAt });
  return token;
}

/** Resolve a token to its account email, or null if unknown/expired. */
export async function resolveSession(token: string): Promise<{ email: string } | null> {
  const clean = (token ?? "").trim();
  if (!clean || clean.length < 32) return null;
  const record = await sessions().get(clean);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    try {
      await sessions().delete(clean);
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
    await sessions().delete(clean);
  } catch (e) {
    console.warn(`[sessions] revoke failed: ${String(e)}`);
  }
}
