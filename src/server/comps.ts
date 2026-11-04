/**
 * FREE-ACCESS GRANTS ("comps") — the owner's list of people who use the site
 * without paying.
 *
 * WHY THIS FILE EXISTS (owner request, 2026-11-02): "How can I give someone free
 * use of the site? I need to get feedback from a human new to match betting."
 * Until now the only ways were the owner's own comped seat (src/server/users.ts)
 * or hand-editing `.run/users.json` on the host — not something to ask a
 * non-technical owner to do. Trialists, reviewers and friends need access before
 * and after launch.
 *
 * TWO STORES, ONE MEANING:
 *   • the GRANT LEDGER (this file, `.run/comps.json`) is the owner's list. It
 *     holds every grant, including one given to an address that has not signed
 *     up yet, so the panel can show and revoke it before the account exists;
 *   • the ACCOUNT RECORD carries the comp too (`StoredUser.comp`), because that
 *     is what entitlement is decided from — see src/server/entitlement.ts.
 * A grant is written to both. Registration (and any later lookup) copies a
 * ledger grant onto the account record, so an address comped before it signed up
 * gets the access the moment the account is created. Revoking clears both.
 *
 * THE RULE IS NOT WEAKENED HERE. A grant is dated, or it is explicitly undated
 * (`permanent: true`); `compGrants()` in entitlement.ts decides. Nothing in this
 * file can grant access by being absent, blank or unparseable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cwdRunFile, writeRunFile } from "./run-dir";
import { dirname, join } from "node:path";
import { compGrants, isKnownPlan, type CompState, type Plan } from "./entitlement";

/** A ledger entry: the comp, plus the address it belongs to. */
export interface CompGrant extends CompState {
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Default length of a grant when the owner does not say (days). */
export const DEFAULT_COMP_DAYS = 30;

/** Longest grant we will accept, so a typo cannot mean "for ever". */
export const MAX_COMP_DAYS = 730;

export function compsFile(): string {
  return cwdRunFile(process.env.COMPS_FILE, "comps.json");
}

function loadComps(): Record<string, CompGrant> {
  const file = compsFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, CompGrant>) : {};
  } catch {
    // A corrupt ledger must not grant anything. The account records still hold
    // their own comps, so access survives; the list is just empty.
    return {};
  }
}

function saveComps(comps: Record<string, CompGrant>): void {
  const file = compsFile();
  writeRunFile(file, JSON.stringify(comps, null, 2));
}

/** The grant on file for this address, live or not. */
export function readComp(email: string): CompGrant | null {
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean) return null;
  return loadComps()[clean] ?? null;
}

/** The grant for this address ONLY if it grants access right now. */
export function liveComp(email: string, nowMs: number = Date.now()): CompGrant | null {
  const comp = readComp(email);
  return comp && compGrants(comp, nowMs) ? comp : null;
}

/** Every grant on file, newest first — the panel's list. */
export function listComps(): CompGrant[] {
  return Object.values(loadComps()).sort((a, b) =>
    (b.grantedAt ?? "").localeCompare(a.grantedAt ?? ""),
  );
}

export function putComp(grant: CompGrant): void {
  const comps = loadComps();
  comps[grant.email.trim().toLowerCase()] = { ...grant, email: grant.email.trim().toLowerCase() };
  saveComps(comps);
}

/** Remove the ledger entry. Returns true when there was one. */
export function removeComp(email: string): boolean {
  const clean = (email ?? "").trim().toLowerCase();
  const comps = loadComps();
  if (!comps[clean]) return false;
  delete comps[clean];
  saveComps(comps);
  return true;
}

/** The plan/end-date/note part of a grant, without the address. */
export function compOf(grant: CompGrant): CompState {
  return {
    plan: grant.plan,
    endsAt: grant.endsAt,
    permanent: grant.permanent === true,
    note: grant.note,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
  };
}

export type GrantParse = { ok: true; grant: CompGrant } | { ok: false; error: string };

/**
 * Validate what the owner typed into the panel.
 *
 * `days` defaults to DEFAULT_COMP_DAYS. `permanent` is the ONLY way to make a
 * grant with no end date, and it has to be asked for explicitly — so "no end
 * date" is always a decision, never a blank field.
 */
export function parseGrantInput(
  body: unknown,
  grantedBy: string,
  nowMs: number = Date.now(),
): GrantParse {
  const input = (body ?? {}) as Record<string, unknown>;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter the email address of the person you want to give free access to." };
  }
  const rawPlan = typeof input.plan === "string" ? input.plan.trim().toLowerCase() : "pro";
  if (!isKnownPlan(rawPlan)) {
    return { ok: false, error: "Choose a plan: Starter, Pro or Pro Annual." };
  }
  const plan: Plan = rawPlan;
  const permanent = input.permanent === true;

  let endsAt: string | null = null;
  if (!permanent) {
    const rawDays = input.days === undefined || input.days === null || input.days === ""
      ? DEFAULT_COMP_DAYS
      : Number(input.days);
    if (!Number.isFinite(rawDays) || rawDays <= 0) {
      return { ok: false, error: "Enter how many days the free access should last (for example 30)." };
    }
    const days = Math.min(MAX_COMP_DAYS, Math.floor(rawDays));
    endsAt = new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
  return {
    ok: true,
    grant: {
      email,
      plan,
      endsAt,
      permanent,
      note,
      grantedBy: grantedBy.trim().toLowerCase(),
      grantedAt: new Date(nowMs).toISOString(),
    },
  };
}
