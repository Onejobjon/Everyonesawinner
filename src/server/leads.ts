/**
 * LEAD CAPTURE — "tell me when this launches".
 *
 * Storage is the shared record store (src/server/storage/): `leads.json` on the
 * file driver — a JSON ARRAY of `{name, email, source, createdAt}`, unchanged —
 * or the `eaw_store` table when DATABASE_URL is set.
 *
 * One record per email address: a person who hits the form twice updates the
 * source rather than appending a duplicate. (The JSON path used to append; the
 * Postgres path always upserted. Now both do the same thing, because there is
 * one implementation.)
 */
import { cwdRunFile } from "./run-dir";
import { store } from "./storage";

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
 *  never committed). Only the file driver uses this. */
export function leadsFile(): string {
  return cwdRunFile(process.env.LEADS_FILE, "leads.json");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const leads = () => store<LeadRecord>("leads");

/** Validate the input. Same rules for every driver — there is only one. */
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

/** Store a lead. Keyed by email address, so a repeat submission updates it. */
export async function storeLead(input: LeadInput): Promise<LeadRecord> {
  const { name, email, source } = validateLead(input);
  const existing = await leads().get(email);
  const record: LeadRecord = {
    name,
    email,
    source,
    // Keep the first sighting: "when did this person first ask" is the useful
    // date, and a second form submission must not rewrite it.
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await leads().put(email, record);
  return record;
}
