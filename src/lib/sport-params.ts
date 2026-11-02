/**
 * The FINITE set of `?sport=` values `/api/odds` will answer.
 *
 * WHY THIS EXISTS (2026-11-02): `/api/odds?sport=...` took the value straight
 * from the query string and pasted it into the paid upstream URL. Every distinct
 * string was a new cache key, so a stranger looping `?sport=anything` on a
 * public endpoint got a fresh provider request per call — an open tap on the
 * credit balance, with no account needed. The endpoint is public on purpose
 * (`/free-bets` reads it without a login), so the fix cannot be "require a
 * subscription". The fix is to make the set of accepted values finite and
 * decided here, on the server, and to answer anything else WITHOUT touching the
 * provider — a rejected request costs zero credits.
 *
 * The accepted set is:
 *   • "upcoming" — the all-sports feed the dashboard and free-bets page use; and
 *   • every sport key in src/data/sports-catalogue.json — the provider's own
 *     competition list, which is what the site's sport pages and the Lay Bet
 *     Finder can legitimately ask for (and which already excludes ice hockey).
 *
 * api/odds.ts (the Vercel function) carries a copy of this list because that
 * deployment cannot import from `src/`; `test/money-state.test.ts` fails if the
 * two ever disagree, so the copy cannot rot.
 */
import catalogue from "../data/sports-catalogue.json";


/** The all-sports feed (not a competition key). */
export const UPCOMING = "upcoming";

interface CatalogueSport {
  key: string;
}

/** Every sport key the site may ask the provider for. */
export const CATALOGUE_SPORT_KEYS: readonly string[] = (
  (catalogue as { sports?: CatalogueSport[] }).sports ?? []
).map((s) => s.key);

const ACCEPTED = new Set<string>([UPCOMING, ...CATALOGUE_SPORT_KEYS]);

/** True only for "upcoming" or a competition key from the catalogue. */
export function isAcceptedSport(sport: unknown): sport is string {
  return typeof sport === "string" && ACCEPTED.has(sport);
}

/**
 * The sport to serve for a request, or null when the value is not accepted.
 * A missing value means "upcoming" (the historical default); anything else must
 * be in the accepted set — no trimming, no case-folding, no guessing.
 */
export function resolveSportParam(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return UPCOMING;
  return isAcceptedSport(raw) ? raw : null;
}

/** The plain-language refusal used by both servers. */
export const REJECTED_SPORT_MESSAGE =
  "That competition isn't one we cover. Live odds are only served for our listed competitions and the all-sports feed.";
