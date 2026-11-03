/**
 * Outbound-click log for `/go/<slug>`.
 *
 * ONE LINE PER CLICK, and only three fields: which brand slug, when, and which
 * of OUR pages the visitor came from. Nothing personal is recorded — no IP, no
 * user agent, no cookie, no session, no account, and no query string from the
 * referring page (a query string can carry someone's email). That is the whole
 * point of the file: it answers "do people click through to Bet365 from the
 * offers page?" and nothing else.
 *
 * Storage is an append-only JSONL file (`.run/affiliate-clicks.jsonl` by
 * default, or `$CLICKS_FILE`), the same durable-directory convention the leads
 * store uses. A logging failure must never stop a redirect: `logAffiliateClick`
 * swallows its own errors and returns the record either way.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClickRecord {
  /** Brand slug the visitor clicked (`/go/<slug>`). */
  slug: string;
  /** ISO timestamp of the click. */
  at: string;
  /** Path of the page the click came from, e.g. "/free-bets". "" when unknown. */
  from: string;
}

/** Where the click log lives. Same `.run/` convention as the leads store. */
export function clicksFile(): string {
  return process.env.CLICKS_FILE || join(process.cwd(), ".run", "affiliate-clicks.jsonl");
}

/**
 * Reduce a `Referer` header to a path on OUR site.
 *
 * Only the pathname is kept: the host is dropped (so the log cannot become a
 * list of where visitors were before us) and so is the query string. Anything
 * unparseable, or a referer from another site, becomes "" — "we don't know",
 * never a guess.
 */
export function referringPath(referer: string | null | undefined): string {
  const raw = (referer || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const ours =
      url.hostname === "localhost" ||
      /(^|\.)everyonesawinner\.uk$/i.test(url.hostname) ||
      /\.cto\.site$/i.test(url.hostname);
    // A referer from another site is not one of our pages — record nothing.
    if (!ours) return "";
    return url.pathname.slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Append one click record. Never throws: a broken log must not cost a visitor
 * the link they clicked.
 */
export function logAffiliateClick(input: {
  slug: string;
  at?: string;
  from?: string;
}): ClickRecord {
  const record: ClickRecord = {
    slug: input.slug,
    at: input.at ?? new Date().toISOString(),
    from: input.from ?? "",
  };
  try {
    const file = clicksFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (e) {
    console.warn(`[go] click not logged (${record.slug}): ${String(e)}`);
  }
  return record;
}
