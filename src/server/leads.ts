/**
 * Lead capture storage — server-side only.
 *
 * Persists captured leads (name / email / source / date) to a JSON file so they
 * survive restarts and are retrievable by the team — never held in memory only.
 * Intentionally minimal for now (the lead's "for now storage + thankyou state"
 * scope): a single append to a durable JSON file.
 *
 * Upgrade path: swap `storeLead` for a Postgres `leads` table (src/db.ts) once a
 * DATABASE_URL is connected. The callers (serve-static.ts and api/leads.ts) only
 * depend on this function's return value, so the storage backend is swappable
 * without touching them.
 */
import { dirname, join } from "node:path";
import { ensureSchema, hasDatabase, query } from "./db-pg";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface LeadInput {
  name: string;
  email: string;
  /** Where the lead came from (e.g. "free-bets-page", "homepage-banner"). */
  source: string;
}

export interface LeadRecord extends LeadInput {
  /** ISO timestamp when the lead was captured. */
  createdAt: string;
}

/** Resolve the lead store file path. `LEADS_FILE` overrides; default is
 *  `.run/leads.json` relative to the process working directory (gitignored, so
 *  never committed). */
export function leadsFile(): string {
  return process.env.LEADS_FILE || join(process.cwd(), ".run", "leads.json");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate and append a lead. Throws on invalid input; callers map errors to
 *  a 400 response. */
function storeLeadJson(input: LeadInput): LeadRecord {
  const name = (input.name ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const source = (input.source ?? "unknown").trim();

  if (!name || name.length > 120) {
    throw new Error("A name is required.");
  }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new Error("A valid email address is required.");
  }

  const file = leadsFile();
  mkdirSync(dirname(file), { recursive: true });

  let leads: LeadRecord[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) leads = parsed;
    } catch {
      leads = [];
    }
  }

  const record: LeadRecord = {
    name,
    email,
    source,
    createdAt: new Date().toISOString(),
  };
  leads.push(record);
  writeFileSync(file, JSON.stringify(leads, null, 2));
  return record;
}


/** Validate the input the same way for both backends. */
function validateLead(input: LeadInput): LeadInput {
  const name = (input.name ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const source = (input.source ?? "unknown").trim();
  if (!name || name.length > 120) throw new Error("A name is required.");
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new Error("A valid email address is required.");
  }
  return { name, email, source };
}

/** Postgres-backed lead capture. A repeat email updates the source instead of
 *  failing — a person can hit the form twice without breaking the page. */
async function storeLeadDb(input: LeadInput): Promise<LeadRecord> {
  const { name, email, source } = validateLead(input);
  await ensureSchema();
  await query(
    `INSERT INTO leads (email, name, source) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE SET source = EXCLUDED.source`,
    [email, name, source],
  );
  return { name, email, source, createdAt: new Date().toISOString() };
}

/** Store a lead. Postgres when DATABASE_URL is set, JSON file otherwise. */
export async function storeLead(input: LeadInput): Promise<LeadRecord> {
  if (hasDatabase()) return storeLeadDb(input);
  if (!warnedNonDurableLeads) {
    warnedNonDurableLeads = true;
    console.warn(
      "[leads] DATABASE_URL is not set — leads are stored in a JSON file that does NOT survive a redeploy.",
    );
  }
  return storeLeadJson(input);
}

let warnedNonDurableLeads = false;
