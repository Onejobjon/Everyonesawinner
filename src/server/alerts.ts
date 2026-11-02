/**
 * Opportunity alert worker — server-side (Bun runtime only).
 *
 * Watches for GREEN lay-bet opportunities across every sport the vendor covers
 * for today. The cash rule is the same one the Instant Wins feed uses: the trade
 * must be profitable on BOTH sides after exchange commission at the alert stake
 * (calcLay().profitLoss > 0). There is no odds floor, no odds ceiling and no
 * lay-gap threshold — a green trade at 1.05 alerts exactly like one at 14.0.
 * Ice hockey is excluded at the data layer (its lay odds are nulled in
 * transformMatches).
 *
 * Delivery channels (each independent, all disabled until configured):
 *   A. Webhook — POST JSON to ALERT_WEBHOOK_URL with an HMAC-SHA256 signature
 *      header (secret ALERT_WEBHOOK_SECRET).
 *   B. Email — short plain-text alert to ALERT_EMAIL_TO via the Resend HTTP API
 *      (ALERT_EMAIL_API_KEY + ALERT_EMAIL_FROM).
 *   C. Telegram (optional) — message to TELEGRAM_CHAT_ID via the Bot API
 *      (TELEGRAM_BOT_TOKEN).
 *
 * Quota-aware: the-odds-api.com free tier is ~500 requests/month. The worker
 * reuses a fresh on-disk cache instead of re-fetching, and runs on a
 * conservative configurable schedule. Dedup is persisted so the same
 * opportunity (match + outcome + rounded odds) is never re-alerted.
 *
 * EXPLICITLY OUT OF SCOPE: any automated bet placement or bookmaker login.
 * This is an alert feed only — it tells the owner what exists, never acts on it.
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { transformMatches, type Match, type MatchOutcome } from "../lib/odds-api";
import { ODDS_API_KEY, oddsKeyProblem, logOddsKeyState } from "./odds-key";
import {
  DEFAULT_COMMISSION,
  calcLay,
  calcFreeBetProfit,
  layGap,
  round2,
} from "../lib/odds";
import { checkBackLayPair, isSameBookmakerKey } from "../lib/odds-sanity";
import { readGreenHistory, recordGreens } from "./green-history";
import { pushSnapshot } from "./scan-bridge";

const BASE = "https://api.the-odds-api.com/v4";
const REGIONS = "uk";
const MARKETS = "h2h"; // h2h_lay is auto-included with h2h — no need to request it
const BACK_STAKE = 20;

/**
 * Exchange commission the ALERT RULE assumes — the same default as the site
 * (OWNER DIRECTIVE 2026-10-28: 2% on Smarkets and Betfair).
 *
 * This is the worker's own assumption, not a user setting: an alert has no
 * user to ask, so it uses the default and SAYS SO in the log, once per scan
 * (`commission assumed: 2% ...`). A deployment that pays a different rate can
 * set `EXCHANGE_COMMISSION` to a fraction (e.g. "0.05").
 */
export const ALERT_COMMISSION = (() => {
  const raw = Number(process.env.EXCHANGE_COMMISSION);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : DEFAULT_COMMISSION;
})();

/** "2%" — for the once-per-scan log line. */
function commissionPct(): string {
  return `${Math.round(ALERT_COMMISSION * 1000) / 10}%`;
}

// Free-bet freshness guard: skip a freebet row unless the back and lay prices
// were last updated within this window of each other. Stale or sparse exchange
// lay data (e.g. minor-league ice hockey) can show lay < back, which would
// otherwise fire fake "free bet >100%" alerts. The cash rule is unaffected —
// its tight close-lay gap already bounds the harm.
const FRESHNESS_MAX_GAP_MS = 60 * 60_000; // 60 minutes

// Minimum lead time an alert needs to be actionable: the user must be able to
// place the back AND lay before kick-off. Anything closer than this is skipped.
const ACTIONABILITY_BUFFER_MS = 15 * 60_000; // 15 minutes

// ── Config (all env-var driven, safe defaults) ─────────────────────────────
// How often the worker runs a check (minutes). Default 10 = matches the site's
// 10-minute odds refresh, so an opportunity is alerted as soon as it is scanned
// rather than sitting until the next hour (owner directive, 2026-10-27).
const CHECK_INTERVAL_MIN = num(process.env.ALERT_CHECK_INTERVAL_MIN, 10);
// NOTE: there is no single snapshot TTL any more — each SPORT has its own
// freshness window (SPORT_ODDS_TTL_MIN below), because a same-day sweep is one
// credit per sport and 20 sports every 10 minutes would burn the month in a day.

// Channel A — webhook
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.ALERT_WEBHOOK_SECRET || "";
// Channel B — email (Resend)
const EMAIL_API_KEY = process.env.ALERT_EMAIL_API_KEY || "";
const EMAIL_FROM = process.env.ALERT_EMAIL_FROM || "";
const EMAIL_TO = process.env.ALERT_EMAIL_TO || "";
// Channel C — Telegram (env names per owner spec)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Overridable so tests can prove the instrumentation without touching real state.
const RUN_DIR = process.env.ALERTS_RUN_DIR || join(import.meta.dir, "../../.run");
const CACHE_FILE = join(RUN_DIR, "alerts-cache.json");
const SEEN_FILE = join(RUN_DIR, "alerts-seen.json");
const LOG_FILE = join(RUN_DIR, "alerts.log");
const HEALTH_FILE = join(RUN_DIR, "alerts-health.json");
// Written on every COMPLETED scan (hit or miss). The odds cache below only
// updates on a cache miss, so it cannot answer "is the worker still scanning?" —
// this file can, and the gap alarm (src/server/gap-alarm.ts) reads it.
const LAST_SCAN_FILE = join(RUN_DIR, "alerts-last-scan.json");
// Append-only, one JSON object per scan: how spend is measured instead of guessed.
const CREDITS_FILE = join(RUN_DIR, "credits.jsonl");
const SEEN_MAX = 4000; // cap the persisted dedup set so it can't grow unbounded

// Live surface to health-check. Must serve JSON odds for the site to be
// "working". Overridable via env for portability. NOTE: this hits the /api/odds
// proxy, which forwards to the odds API — so it costs odds-API quota. The
// worker runs 3-hourly, so this adds ~1 odds-API call per scan (the platform
// URL's health is implied by the worker's own scan fetch, so we only check the
// public domain).
const HEALTH_DOMAIN_URL =
  process.env.HEALTH_DOMAIN_URL ||
  "https://www.everyonesawinner.uk/api/odds?sport=upcoming";

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function log(msg: string): void {
  const line = `[alerts ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, existing + line + "\n", "utf8");
  } catch {
    /* logging must never break the worker */
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

type AlertType = "cash" | "freebet";

interface BaseOpportunity {
  type: AlertType;
  matchId: string;
  match: string; // "Home vs Away" (webhook/email)
  home: string;
  away: string;
  league: string;
  kickoff: string; // full ISO commence time (sorting)
  kickoffTime: string; // HH:MM (display)
  bookmaker: string;
  outcome: string;
  backOdds: number;
  layOdds: number;
  /** The exchange laid against (for the greens history; null when unknown). */
  laySource?: string | null;
  gap: number;
  detectedAt: string;
}

/** GREEN CASH — close-lay qualifying profit on a £20 cash back bet. */
interface CashOpportunity extends BaseOpportunity {
  type: "cash";
  layStake: number;
  liability: number;
  expectedProfit: number;
}

/** FREE BET 100%+ — SNR free bet retains more than its own stake (arb-grade). */
interface FreebetOpportunity extends BaseOpportunity {
  type: "freebet";
  freeBetProfit: number;
  retentionPct: number;
}

type Opportunity = CashOpportunity | FreebetOpportunity;

// ── Odds fetch (server-side, cache-aware) ─────────────────────────────────

// Last x-requests-remaining value seen from the odds API (quota visibility).
let lastRequestsRemaining: number | null = null;

/**
 * One scan's odds-API cost, as the API itself reports it.
 *
 * The Odds API bills PER REQUEST, not per event: `x-requests-last` is 1 for a
 * 21-event league query and 1 for the generic feed. Reading both headers at the
 * moment of the fetch is the only cost measurement that cannot drift from the
 * shopkeeper's answer. A cache hit spends nothing and is recorded as last=0.
 */
interface ScanCredits {
  last: number | null;
  remaining: number | null;
  events: number;
  cache: "hit" | "miss";
}
let lastScanCredits: ScanCredits | null = null;

/**
 * Remaining quota as last seen by ANY process. A cache hit spends nothing and
 * learns nothing, so without this it would log `remaining=unknown` on every
 * warm scan; the rollup is the memory the worker keeps between restarts.
 */
function lastKnownRemaining(): number | null {
  if (lastRequestsRemaining != null) return lastRequestsRemaining;
  try {
    if (!existsSync(CREDITS_FILE)) return null;
    const rows = readFileSync(CREDITS_FILE, "utf8").trim().split("\n").reverse();
    for (const row of rows) {
      const parsed = JSON.parse(row) as { remaining?: number | null };
      if (typeof parsed.remaining === "number") return parsed.remaining;
    }
  } catch {
    /* no usable history — unknown is the honest answer */
  }
  return null;
}

// ── Wide same-day sweep (budgeted) ─────────────────────────────────────────
//
// WHY THIS IS NOT `/sports/upcoming/odds/` ANY MORE (measured 2026-11-02):
// the `upcoming` endpoint answers with events commencing in the next few HOURS,
// not the rest of the day. The exact URL the worker used to call returned 11
// events / 3 sports (tennis_atp_paris_masters, basketball_ncaab,
// soccer_spain_segunda_division), latest kick-off 14:30Z — and passing
// `commenceTimeFrom`/`commenceTimeTo` changed nothing (11 events again, same
// three sports). Meanwhile the FREE `/sports/{key}/events/` endpoints showed 55
// un-started fixtures today across 20 sports. So the narrow window was the
// limiter, not our filters.
//
// THE COST STRUCTURE that follows from that:
//   • `/sports/?all=false`        — 0 credits (x-requests-last: 0, verified)
//   • `/sports/{key}/events/`     — 0 credits (79 calls, remaining unchanged)
//   • `/sports/{key}/odds/`       — 1 credit PER SPORT (billed per request)
// So a full same-day sweep of 20 sports is 20 credits — 20× the old 1-credit
// scan. To keep the owner's quota intact the sweep is budgeted rather than
// widened blindly:
//   • the free index says WHICH sports have a fixture today (refreshed every
//     INDEX_TTL_MIN, costs nothing);
//   • a sport's odds are only re-fetched once its own copy is older than
//     SPORT_ODDS_TTL_MIN;
//   • at most MAX_SPORT_FETCHES sports are paid for in one scan, most urgent
//     kick-off first — so the fixtures closest to starting are always the
//     freshest, and the rest rotate.
// At today's measured 20 same-day sports that is ~20 fetches per 90 minutes
// (~13/hour, ~320/day, ~9.6k/month) instead of 20 credits every 10 minutes
// (~2,900/day). Exact per-scan spend is logged and rolled up in credits.jsonl.
const SPORT_ODDS_TTL_MIN = num(process.env.ALERT_SPORT_ODDS_TTL_MIN, 90);
const MAX_SPORT_FETCHES = Math.max(1, Math.floor(num(process.env.ALERT_MAX_SPORT_FETCHES, 3)));
const INDEX_TTL_MIN = num(process.env.ALERT_INDEX_TTL_MIN, 30);
const INDEX_FILE = join(RUN_DIR, "alerts-sports-index.json");
/** How far ahead the per-sport odds call is asked for. Today's fixtures plus slack. */
const ODDS_WINDOW_HOURS = 26;
/** Small gap between free index calls: a concurrency-8 burst earned HTTP 429s. */
const INDEX_GAP_MS = 90;

interface SportIndexEntry {
  key: string;
  title: string;
  /** Fixtures kicking off today in Europe/London that have not started. */
  todayFixtures: number;
  /** Soonest such kick-off (ISO), for priority ordering. */
  nextKickoff: string | null;
}

interface SportsIndex {
  ts: number;
  sportsInSeason: number;
  /** Only sports with at least one same-day fixture — the ones worth paying for. */
  sports: SportIndexEntry[];
  totalTodayFixtures: number;
  /** Free calls that failed (rate limit, network) — coverage is understated, not invented. */
  failed: number;
}

interface SportCacheEntry {
  fetchedAt: number;
  fixtures: number;
  events: number;
}

interface ScanCache {
  ts: number;
  data: Match[];
  perSport?: Record<string, SportCacheEntry>;
  index?: { ts: number; sportsInSeason: number; sportsWithToday: number; totalTodayFixtures: number };
}

/** One HTTP GET that also reads the vendor's own credit headers. */
async function getJson(url: string): Promise<{
  status: number;
  last: number | null;
  remaining: number | null;
  body: unknown;
}> {
  const res = await fetch(url);
  const remainingHdr = res.headers.get("x-requests-remaining");
  const lastHdr = res.headers.get("x-requests-last");
  const remaining =
    remainingHdr != null && remainingHdr !== "" && !Number.isNaN(Number(remainingHdr))
      ? Number(remainingHdr)
      : null;
  const last =
    lastHdr != null && lastHdr !== "" && !Number.isNaN(Number(lastHdr)) ? Number(lastHdr) : null;
  if (remaining != null) lastRequestsRemaining = remaining;
  if (!res.ok) {
    await res.text().catch(() => "");
    return { status: res.status, last, remaining, body: null };
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, last, remaining, body };
}

function auth(path: string): string {
  return `${BASE}${path}${path.includes("?") ? "&" : "?"}apiKey=${ODDS_API_KEY}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** London calendar day of an instant, as YYYY-MM-DD. */
function londonDay(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

/**
 * The free half of the sweep: which sports are in season, and which of them have
 * a fixture kicking off TODAY (Europe/London) that has not started.
 *
 * Costs zero credits. Cached on disk for INDEX_TTL_MIN so a 10-minute scan loop
 * does not hammer 78 free endpoints every time. A failed call is COUNTED, never
 * treated as "that sport has nothing on" — an understated coverage number that
 * says so is honest; a silently short list is not.
 */
async function fetchSportsIndex(now: Date = new Date()): Promise<SportsIndex> {
  try {
    if (existsSync(INDEX_FILE)) {
      const cached = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as SportsIndex;
      if (Number.isFinite(cached?.ts) && Date.now() - cached.ts < INDEX_TTL_MIN * 60_000) {
        return cached;
      }
    }
  } catch {
    /* unreadable index — rebuild it */
  }

  const list = await getJson(auth("/sports/?all=false"));
  const all = Array.isArray(list.body) ? (list.body as { key?: string; title?: string; active?: boolean }[]) : [];
  const inSeason = all.filter((s) => s.active !== false && typeof s.key === "string");

  const today = londonDay(now);
  const sports: SportIndexEntry[] = [];
  let totalTodayFixtures = 0;
  let failed = 0;

  for (const s of inSeason) {
    const key = s.key as string;
    let r = await getJson(auth(`/sports/${key}/events/?dateFormat=iso`));
    if (r.status === 429) {
      // Bursts are what earn a 429 (sequential calls do not); one paced retry.
      await sleep(2500);
      r = await getJson(auth(`/sports/${key}/events/?dateFormat=iso`));
    }
    if (r.status !== 200 || !Array.isArray(r.body)) {
      failed++;
      continue;
    }
    const todays = (r.body as { commence_time?: string }[]).filter((e) => {
      const t = e?.commence_time;
      if (typeof t !== "string") return false;
      return londonDay(t) === today && new Date(t).getTime() > now.getTime();
    });
    if (todays.length > 0) {
      const times = todays.map((e) => e.commence_time as string).sort();
      sports.push({
        key,
        title: s.title ?? key,
        todayFixtures: todays.length,
        nextKickoff: times[0] ?? null,
      });
      totalTodayFixtures += todays.length;
    }
    await sleep(INDEX_GAP_MS);
  }

  const index: SportsIndex = {
    ts: Date.now(),
    sportsInSeason: inSeason.length,
    sports,
    totalTodayFixtures,
    failed,
  };
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(INDEX_FILE, JSON.stringify(index));
  } catch (e) {
    log(`sports index write failed: ${String(e)}`);
  }
  log(
    `coverage index: ${inSeason.length} sports in season, ${sports.length} with a fixture today, ` +
      `${totalTodayFixtures} same-day fixtures${failed ? `, ${failed} sports index calls failed` : ""} (0 credits)`,
  );
  return index;
}

/**
 * Read the scan cache, widening it: refresh the free index, then pay for odds for
 * the sports that (a) have a same-day fixture, (b) whose cached odds are older
 * than SPORT_ODDS_TTL_MIN, most urgent kick-off first, up to MAX_SPORT_FETCHES.
 *
 * The cache holds what the scan SAW — every fixture for a fetched sport, whether
 * or not it has a lay price, and whether or not it is green. The green test
 * happens when the feed is built, never here.
 */
async function getMatches(): Promise<Match[]> {
  if (!ODDS_API_KEY) throw new Error(oddsKeyProblem() || "ODDS_API_KEY missing");

  let cache: ScanCache = { ts: 0, data: [], perSport: {} };
  try {
    if (existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<ScanCache>;
      if (Array.isArray(parsed?.data)) {
        cache = {
          ts: typeof parsed.ts === "number" ? parsed.ts : 0,
          data: parsed.data as Match[],
          perSport: (parsed.perSport ?? {}) as Record<string, SportCacheEntry>,
          index: parsed.index,
        };
      }
    }
  } catch {
    /* unreadable cache — rebuild below */
  }

  const index = await fetchSportsIndex();

  // Most urgent first: the sport whose next same-day fixture starts soonest is
  // the one a user can still act on, so it gets the freshest prices.
  const queue = [...index.sports]
    .filter((s) => {
      const entry = cache.perSport?.[s.key];
      if (!entry) return true;
      return Date.now() - entry.fetchedAt >= SPORT_ODDS_TTL_MIN * 60_000;
    })
    .sort((a, b) => (a.nextKickoff ?? "9").localeCompare(b.nextKickoff ?? "9"));

  const from = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const to = new Date(Date.now() + ODDS_WINDOW_HOURS * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");

  let spent = 0;
  let fetched = 0;
  let remaining = lastKnownRemaining();
  const perSport: Record<string, SportCacheEntry> = { ...(cache.perSport ?? {}) };
  let data = [...cache.data];

  for (const sport of queue.slice(0, MAX_SPORT_FETCHES)) {
    const path =
      `/sports/${sport.key}/odds/?regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal` +
      `&commenceTimeFrom=${from}&commenceTimeTo=${to}`;
    let r = await getJson(auth(path));
    if (r.status === 429) {
      await sleep(2500);
      r = await getJson(auth(path));
    }
    if (r.status !== 200 || !Array.isArray(r.body)) {
      log(`sport fetch failed: ${sport.key} HTTP ${r.status}`);
      continue;
    }
    spent += r.last ?? 0;
    if (r.remaining != null) remaining = r.remaining;
    const matches = transformMatches(r.body as Parameters<typeof transformMatches>[0]);
    // Replace this sport's slice; keep every other sport exactly as cached.
    data = data.filter((m) => m.sportKey !== sport.key).concat(matches);
    perSport[sport.key] = {
      fetchedAt: Date.now(),
      fixtures: matches.length,
      events: (r.body as unknown[]).length,
    };
    fetched++;
  }

  // Prune what can no longer be shown or traded: started fixtures and sports
  // that are no longer in season. Keeps the cache from growing without bound.
  const nowMs = Date.now();
  const inSeason = new Set(index.sports.map((s) => s.key));
  data = data.filter((m) => {
    const t = Date.parse(m.commenceTime);
    if (Number.isFinite(t) && t <= nowMs) return false;
    if (m.sportKey && perSport[m.sportKey] && !inSeason.has(m.sportKey)) return false;
    return true;
  });

  const next: ScanCache = {
    ts: Date.now(),
    data,
    perSport,
    index: {
      ts: index.ts,
      sportsInSeason: index.sportsInSeason,
      sportsWithToday: index.sports.length,
      totalTodayFixtures: index.totalTodayFixtures,
    },
  };
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(next));
  } catch (e) {
    log(`cache write failed: ${String(e)}`);
  }

  // `last` is now the TOTAL credits this scan spent (0..MAX_SPORT_FETCHES), not
  // a single request's cost — the sum of the vendor's own x-requests-last values.
  lastScanCredits = {
    last: spent,
    remaining: remaining ?? lastKnownRemaining(),
    events: data.length,
    cache: fetched === 0 ? "hit" : "miss",
  };
  log(
    `sweep: ${fetched} sport${fetched === 1 ? "" : "s"} refreshed (${spent} credit${spent === 1 ? "" : "s"}), ` +
      `${queue.length - fetched} due, ${data.length} fixtures held, ` +
      `${index.sports.length} sports with a fixture today / ${index.totalTodayFixtures} fixtures`,
  );
  return data;
}

// ── Filter ─────────────────────────────────────────────────────────────────

/**
 * Free-bet freshness guard. A free-bet >100% row is only trustworthy when:
 *   (a) its league has genuine exchange lay coverage (Betfair/Smarkets quoting
 *       h2h_lay), and
 *   (b) both the back and lay prices have last_update timestamps within 60 min
 *       of each other.
 * Stale/sparse exchange lay data (minor leagues) can show lay < back and would
 * otherwise fire fake alerts. The cash rule does not use this guard.
 */
function freebetRowIsFresh(m: Match, o: MatchOutcome): boolean {
  if (!m.hasLayCoverage) return false;
  const backTs = o.backLastUpdate ? Date.parse(o.backLastUpdate) : NaN;
  const layTs = o.layLastUpdate ? Date.parse(o.layLastUpdate) : NaN;
  if (!Number.isFinite(backTs) || !Number.isFinite(layTs)) return false;
  return Math.abs(backTs - layTs) <= FRESHNESS_MAX_GAP_MS;
}

/**
 * `commission` is the exchange commission the rule assumes. It defaults to
 * ALERT_COMMISSION (2%) and is a parameter only so a test can prove the rule at
 * two rates side by side — production never passes it.
 */
export function findOpportunities(
  matches: Match[],
  commission: number = ALERT_COMMISSION
): {
  opps: Opportunity[];
  skippedSuspects: number;
  skippedInsane: number;
  skippedStarted: number;
  skippedTooSoon: number;
  /** Rows withheld because the back and the lay came from the same exchange. */
  skippedSameSource: number;
} {
  const opps: Opportunity[] = [];
  let skippedSuspects = 0;
  let skippedInsane = 0;
  let skippedStarted = 0;
  let skippedTooSoon = 0;
  let skippedSameSource = 0;
  const now = Date.now();
  for (const m of matches) {
    // Defense-in-depth on top of the transform guard (which drops started
    // matches at fetch): the worker's on-disk cache can still hold a match for
    // between sweeps after it kicks off, so re-check commence_time here.
    const kickoffMs = Date.parse(m.commenceTime);
    if (Number.isFinite(kickoffMs) && kickoffMs <= now) {
      skippedStarted++;
      continue;
    }
    // An alert arriving with <15 min to kick-off isn't actionable (the user
    // needs time to place the back AND lay). Too-soon candidates stay out of
    // the seen-list, so they can still alert on a later scan if still open.
    if (Number.isFinite(kickoffMs) && kickoffMs - now < ACTIONABILITY_BUFFER_MS) {
      skippedTooSoon++;
      continue;
    }
    for (const o of m.outcomes) {
      const back = o.odds;
      const lay = o.layOdds;
      if (!lay) continue;

      // Back/lay sanity check, defence-in-depth: the data layer already
      // withholds sentinel and cross-coverage lay prices, but this worker's
      // on-disk cache can still hold matches transformed by an older build.
      // A row like SHL "back 5.50 / lay 2.56" must never alert.
      //
      // The same applies to an exchange that is on BOTH sides of the trade: the
      // transform excludes the lay source from best-back selection, and this
      // re-checks it by feed key, so a row like "back 2.66 Betfair / lay 2.70
      // Betfair" from a stale cache can never be announced as a profit.
      if (isSameBookmakerKey(o.bookmakerKey, o.layBookmakerKey)) {
        skippedSameSource++;
        continue;
      }
      if (checkBackLayPair(back, lay, o.bookmakerKey, o.layBookmakerKey).suspect) {
        skippedInsane++;
        continue;
      }

      const base = {
        matchId: m.matchId,
        match: `${m.home} vs ${m.away}`,
        home: m.home,
        away: m.away,
        league: m.league,
        kickoff: m.commenceTime,
        kickoffTime: m.time,
        bookmaker: o.bookmaker,
        outcome: o.name,
        backOdds: back,
        layOdds: lay,
        laySource: o.laySource ?? null,
        gap: layGap(back, lay),
        detectedAt: new Date().toISOString(),
      };

      // GREEN CASH — the ONLY admission rule, in the worker as on the feed:
      // profitable on both sides after commission at this stake. No odds floor,
      // no odds ceiling, no lay-gap threshold (MAX_LAY_GAP is deliberately not
      // consulted here: a 1.05 or a 14.0 green trade must alert, and a tight but
      // unprofitable pair must not).
      {
        const c = calcLay(back, lay, BACK_STAKE, commission);
        if (c && c.profitLoss > 0) {
          opps.push({
            type: "cash",
            ...base,
            layStake: round2(c.layStake),
            liability: round2(c.liability),
            expectedProfit: round2(c.profitLoss),
          });
        }
      }

      // FREE BET 100%+ — SNR free bet retains more than its own stake. These are
      // arb-grade rows where the exchange lay price sits below the bookmaker's
      // back price — genuinely rare, so expect few alerts (correct, not a bug).
      const fb = calcFreeBetProfit(back, lay, BACK_STAKE, commission);
      if (fb && fb > BACK_STAKE) {
        if (!freebetRowIsFresh(m, o)) {
          skippedSuspects++;
          continue;
        }
        opps.push({
          type: "freebet",
          ...base,
          freeBetProfit: round2(fb),
          retentionPct: Math.round((fb / BACK_STAKE) * 100),
        });
      }
    }
  }

  // Cash first, soonest kickoff then best profit; freebets after, best retention first.
  opps.sort((a, b) => {
    if (a.type !== b.type) return a.type === "cash" ? -1 : 1;
    const t = a.kickoff.localeCompare(b.kickoff);
    if (t !== 0) return t;
    if (a.type === "cash") {
      return (b as CashOpportunity).expectedProfit - (a as CashOpportunity).expectedProfit;
    }
    return (b as FreebetOpportunity).freeBetProfit - (a as FreebetOpportunity).freeBetProfit;
  });
  return { opps, skippedSuspects, skippedInsane, skippedStarted, skippedTooSoon, skippedSameSource };
}

// ── Dedup (persisted) ──────────────────────────────────────────────────────

function keyFor(o: Opportunity): string {
  return `${o.type}|${o.matchId}|${o.outcome}|${round2(o.backOdds)}|${round2(o.layOdds)}`;
}

function loadSeen(): Set<string> {
  try {
    if (existsSync(SEEN_FILE)) {
      const arr = JSON.parse(readFileSync(SEEN_FILE, "utf8")) as string[];
      return new Set(arr);
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveSeen(seen: Set<string>): void {
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    let arr = [...seen];
    if (arr.length > SEEN_MAX) arr = arr.slice(arr.length - SEEN_MAX);
    writeFileSync(SEEN_FILE, JSON.stringify(arr));
  } catch (e) {
    log(`seen write failed: ${String(e)}`);
  }
}

// ── Delivery ───────────────────────────────────────────────────────────────

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function payloadFor(o: Opportunity) {
  const base = {
    type: o.type,
    match: o.match,
    league: o.league,
    kickoff: o.kickoff,
    bookmaker: o.bookmaker,
    outcome: o.outcome,
    backOdds: o.backOdds,
    layOdds: o.layOdds,
    gap: o.gap,
    detectedAt: o.detectedAt,
  };
  if (o.type === "cash") {
    return {
      ...base,
      layStake: o.layStake,
      liability: o.liability,
      expectedProfit: o.expectedProfit,
    };
  }
  return {
    ...base,
    freeBetProfit: o.freeBetProfit,
    retentionPct: o.retentionPct,
  };
}

/** Concise human-facing text shared by Telegram and email (full data → webhook). */
export function conciseText(o: Opportunity): string {
  const line1 =
    o.type === "cash"
      ? `💰 GREEN CASH — ${o.outcome} @ ${o.backOdds.toFixed(2)} back / ${o.layOdds.toFixed(2)} lay — £${BACK_STAKE} → ~£${o.expectedProfit.toFixed(2)}`
      : `🎯 FREE BET 100%+ — ${o.outcome} @ ${o.backOdds.toFixed(2)} back / ${o.layOdds.toFixed(2)} lay — £${BACK_STAKE} free bet → £${o.freeBetProfit.toFixed(2)} (${o.retentionPct}%)`;
  const line2 = `${o.home} v ${o.away} · ${o.bookmaker} · kicks off ${o.kickoffTime} · odds move fast`;
  return [line1, line2].join("\n");
}

function emailText(o: Opportunity): string {
  // Same trimmed two lines as Telegram — no league, lay stake, liability, gap
  // or detected-at (webhook payload keeps full data for automation).
  return [conciseText(o), "", "Alert feed only — no bet is placed for you."].join("\n");
}

export function telegramText(o: Opportunity): string {
  return conciseText(o);
}

/** Read a response body as text (bounded), for logging failures. */
async function responseText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    // Read the WHOLE body here: this string is also what we JSON.parse to check
    // Telegram's `ok` flag. Truncating it (it used to be sliced to 300 chars)
    // cut the JSON mid-object, so a delivered message was scored as a failure
    // and re-sent forever. Only the LOGGED copy is shortened — see the log sites.
    return t || "(empty body)";
  } catch {
    return "(no body)";
  }
}

/** Short, log-safe view of a response body. */
function brief(body: string, n = 300): string {
  return body.length > n ? `${body.slice(0, n)}…` : body;
}

async function deliver(o: Opportunity): Promise<void> {
  // A — webhook with HMAC-SHA256 signature. BEST-EFFORT: a secondary-channel
  // failure must never block Telegram, the primary alert channel.
  if (WEBHOOK_URL && WEBHOOK_SECRET) {
    try {
      const body = JSON.stringify(payloadFor(o));
      const sig = await hmacSha256Hex(WEBHOOK_SECRET, body);
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-256": `sha256=${sig}`,
          "x-eaw-timestamp": o.detectedAt,
        },
        body,
      });
      if (!res.ok) log(`webhook returned HTTP ${res.status}`);
    } catch (e) {
      log(`webhook failed: ${String(e)}`);
    }
  } else if (WEBHOOK_URL && !WEBHOOK_SECRET) {
    log("ALERT_WEBHOOK_URL set but ALERT_WEBHOOK_SECRET missing — webhook skipped");
  }

  // B — email. BEST-EFFORT (same rationale as webhook).
  if (EMAIL_TO && EMAIL_API_KEY && EMAIL_FROM) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${EMAIL_API_KEY}`,
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [EMAIL_TO],
          subject: o.type === "cash"
            ? `GREEN CASH: ${o.match} — ${o.outcome}`
            : `FREE BET 100%+: ${o.match} — ${o.outcome}`,
          text: emailText(o),
        }),
      });
      if (!res.ok) log(`email returned HTTP ${res.status}`);
    } catch (e) {
      log(`email failed: ${String(e)}`);
    }
  } else if (EMAIL_TO && !(EMAIL_API_KEY && EMAIL_FROM)) {
    log("ALERT_EMAIL_TO set but ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM missing — email skipped");
  }

  // C — Telegram (critical). Throws on failure so the caller does NOT mark the
  // opportunity seen, and it is retried on the next scan.
  await postTelegram(telegramText(o));
}

// ── Telegram delivery (response-checked, throttled, retried) ───────────────

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: { message_id?: number };
}

// Throttle: ~300ms between Telegram sends, so a burst of alerts never trips
// Telegram's per-chat rate limit (the root cause of "only 1 message arrived").
let lastTelegramSendAt = 0;
const TG_MIN_INTERVAL_MS = 300;

/**
 * Send a Telegram message. Checks BOTH the HTTP status and Telegram's `ok`
 * field (Telegram returns HTTP 200 for logical errors like a 429 rate-limit).
 * Logs success with message_id and failure with status + body. Transient
 * failures (429 / 5xx) are retried, respecting `retry_after`; a permanent
 * failure throws so the caller leaves the opportunity unseen and retries it on
 * the next scan. No-op unless the channel is configured.
 */
async function postTelegram(text: string): Promise<{ ok: boolean; messageId: number | null }> {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    log("telegram skipped — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in this process");
    return { ok: false, messageId: null };
  }

  // Space out sends — never faster than TG_MIN_INTERVAL_MS after the last send.
  const elapsed = Date.now() - lastTelegramSendAt;
  if (elapsed < TG_MIN_INTERVAL_MS) {
    await sleep(TG_MIN_INTERVAL_MS - elapsed);
  }
  lastTelegramSendAt = Date.now();

  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });

    const rawBody = await responseText(res);
    let data: TelegramResponse | null = null;
    try {
      data = JSON.parse(rawBody) as TelegramResponse;
    } catch {
      data = null; // non-JSON body
    }

    const ok = res.ok && !!data && data.ok === true;
    if (ok) {
      const msgId = data?.result?.message_id;
      log(`telegram ok${msgId != null ? ` msg_id=${msgId}` : ""}`);
      return { ok: true, messageId: msgId ?? null };
    }

    const desc = data?.description || `HTTP ${res.status}`;
    const retryAfter = data?.parameters?.retry_after;
    const retriable =
      res.status === 429 || res.status >= 500 || (retryAfter != null && retryAfter > 0);

    if (!retriable || attempt === maxRetries) {
      log(`telegram FAILED (${desc}) — body: ${brief(rawBody)}`);
      throw new Error(
        `telegram send failed: ${desc}${retryAfter != null && retryAfter > 0 ? ` (retry after ${retryAfter}s)` : ""}`
      );
    }

    const waitMs =
      retryAfter != null && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000 * 2 ** attempt, 30_000);
    log(`telegram ${desc} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
    await sleep(waitMs);
    lastTelegramSendAt = Date.now();
  }
  // Unreachable (every path above returns or throws) — keeps the return type honest.
  return { ok: false, messageId: null };
}

/**
 * Delivery self-test. Sends a clearly-labelled message through the SAME
 * postTelegram() code path a real opportunity alert uses (throttle, retries,
 * `ok: true` check), so a green result proves the channel end to end even when
 * a scan finds no qualifying opportunity.
 */
export async function sendTestAlert(): Promise<{ ok: boolean; messageId: number | null }> {
  return postTelegram(
    "✅ Everyone's A Winner — alert delivery check. Scans run every 10 minutes. (Test message, not an opportunity.)"
  );
}

// ── Site health check (never-again monitoring) ──────────────────────────────
// The custom-domain incident (odds broken for days) happened because /api/odds
// fell through to the SPA on Vercel and nobody noticed. This re-checks the
// public domain each worker scan and pings Telegram after TWO consecutive
// broken scans.

interface HealthState {
  domainBroken: number;
}

function loadHealth(): HealthState {
  try {
    if (existsSync(HEALTH_FILE)) return JSON.parse(readFileSync(HEALTH_FILE, "utf8")) as HealthState;
  } catch { /* ignore */ }
  return { domainBroken: 0 };
}

function saveHealth(h: HealthState): void {
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(HEALTH_FILE, JSON.stringify(h));
  } catch { /* logging must never break the worker */ }
}

async function isOddsHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return false;
    const data = (await res.json()) as unknown;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

async function checkSiteHealth(): Promise<void> {
  const h = loadHealth();
  const domainOk = await isOddsHealthy(HEALTH_DOMAIN_URL);
  h.domainBroken = domainOk ? 0 : h.domainBroken + 1;
  saveHealth(h);
  if (h.domainBroken === 2) {
    log("health: domain odds broken for 2 consecutive scans");
    await postTelegram("⚠️ Site odds are broken on the live domain — investigating");
  }
}

/**
 * Record this scan's cost: one greppable log line plus one append-only JSONL
 * row, so a month's burn is a `jq` sum rather than log archaeology.
 */
function recordCredits(c: ScanCredits): void {
  const show = (n: number | null): string => (n == null ? "unknown" : String(n));
  log(`credits: last=${show(c.last)} remaining=${show(c.remaining)} events=${c.events} cache=${c.cache}`);
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    appendFileSync(
      CREDITS_FILE,
      JSON.stringify({ ts: new Date().toISOString(), remaining: c.remaining, last: c.last, events: c.events, cache: c.cache }) + "\n",
      "utf8",
    );
  } catch (e) {
    log(`credits rollup write failed: ${String(e)}`);
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Record that a scan COMPLETED. Deliberately not the odds cache: that file only
 * changes when a scan misses the cache, so a working worker serving cache hits
 * would look dead to anything watching it. This marker moves on every scan, and
 * it is what the gap alarm measures silence against.
 */
function recordScanComplete(result: {
  checked: number;
  alerted: number;
  skippedTooSoon: number;
  skippedStarted: number;
}): void {
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      LAST_SCAN_FILE,
      JSON.stringify({ ts: new Date().toISOString(), ...result }),
      "utf8",
    );
  } catch (e) {
    log(`last-scan marker write failed: ${String(e)}`);
  }
}

/** ISO time of the last completed scan, or null when none has been recorded. */
export function lastScanAt(): string | null {
  try {
    if (!existsSync(LAST_SCAN_FILE)) return null;
    const parsed = JSON.parse(readFileSync(LAST_SCAN_FILE, "utf8")) as { ts?: unknown };
    return typeof parsed?.ts === "string" ? parsed.ts : null;
  } catch {
    return null;
  }
}

export async function runAlertCheck(): Promise<{
  checked: number;
  alerted: number;
  skippedSuspects: number;
  skippedInsane: number;
  skippedStarted: number;
  skippedTooSoon: number;
  skippedSameSource: number;
}> {
  try {
    await checkSiteHealth();
  } catch (e) {
    log(`health check failed: ${String(e)}`);
  }
  // Say what the green-cash rule assumed, once per scan, so a log reader can
  // tell which commission a profit figure was computed at.
  log(
    `commission assumed: ${commissionPct()} exchange commission` +
      (process.env.EXCHANGE_COMMISSION ? " (EXCHANGE_COMMISSION override)" : " (default)"),
  );
  const matches = await getMatches();
  // Exactly one credits line per scan — hit or miss.
  if (lastScanCredits) recordCredits(lastScanCredits);
  const { opps, skippedSuspects, skippedInsane, skippedStarted, skippedTooSoon, skippedSameSource } =
    findOpportunities(matches);
  const seen = loadSeen();

  let alerted = 0;
  for (const o of opps) {
    const k = keyFor(o);
    if (seen.has(k)) continue;
    try {
      await deliver(o);
      seen.add(k);
      alerted++;
    } catch (e) {
      log(`deliver failed for ${k}: ${String(e)}`);
    }
  }
  saveSeen(seen);

  // ── GREENS HISTORY (owner, 2026-11-02) ───────────────────────────────────
  // Greens are rare and they are the proof the subscription is worth paying for.
  // Every green row this scan found is appended once (deduped inside the module),
  // so the page can say "N found in the last 30 days" on a quiet day too.
  // ZERO CREDITS: these rows already passed through the scan.
  try {
    const greenRows = opps
      .filter((o): o is CashOpportunity => o.type === "cash")
      .map((o) => ({
        sport: (matches.find((m) => m.matchId === o.matchId)?.sportKey ?? "") as string,
        match: o.match,
        outcome: o.outcome,
        bookmaker: o.bookmaker,
        backOdds: o.backOdds,
        exchange: o.laySource ?? null,
        layOdds: o.layOdds,
        commission: ALERT_COMMISSION,
      }));
    const rec = recordGreens(greenRows);
    if (greenRows.length > 0) {
      log(
        `greens history: ${rec.appended} new, ${rec.duplicates} repeat${rec.duplicates === 1 ? "" : "s"} of an already-recorded trade, ${rec.notGreen} not green (dropped)`,
      );
    }
  } catch (e) {
    log(`greens history write failed: ${String(e)}`);
  }

  // ── PUSH THE SNAPSHOT TO THE PUBLISHED SITE (ITEM 1, 2026-11-02) ─────────
  // The published copy of the site runs on a different filesystem and cannot read
  // this machine's `.run/`, which is why its feed said "no scan data yet" while
  // this scan was healthy. Push what we already paid for; the receiving host
  // keeps it in memory and serves the feed from there. ZERO extra credits.
  try {
    const cacheFile = join(RUN_DIR, "alerts-cache.json");
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as unknown;
      const report = await pushSnapshot({
        cache,
        greens: readGreenHistory(),
        pushedAt: new Date().toISOString(),
      });
      log(
        `snapshot push: ${report.delivered ? "delivered" : "FAILED"} ${report.fixtures} fixtures` +
          (report.skipped
            ? ` — ${report.skipped}`
            : ` — ${report.attempts.map((a) => `${a.url} ${a.status ?? a.detail}`).join("; ")}`),
      );
    }
  } catch (e) {
    log(`snapshot push failed: ${String(e)}`);
  }

  const cash = opps.filter((o) => o.type === "cash").length;
  const freebet = opps.length - cash;
  log(
    `check done: ${cash} green-cash + ${freebet} freebet, ${alerted} newly alerted, ${skippedSuspects} stale rows skipped, ${skippedInsane} insane back/lay rows skipped, ${skippedSameSource} rows with the same exchange on both sides skipped, skipped started: ${skippedStarted}, too-soon: ${skippedTooSoon}`
  );
  // A scan COMPLETED — move the marker the gap alarm watches. Written after the
  // log line so "check done" and the marker always agree.
  recordScanComplete({
    checked: opps.length,
    alerted,
    skippedTooSoon,
    skippedStarted,
  });
  return {
    checked: opps.length,
    alerted,
    skippedSuspects,
    skippedInsane,
    skippedStarted,
    skippedTooSoon,
    skippedSameSource,
  };
}
export function hasAlertChannel(): boolean {
  return Boolean(
    WEBHOOK_URL || (EMAIL_TO && EMAIL_API_KEY && EMAIL_FROM) || (TG_TOKEN && TG_CHAT_ID),
  );
}

/** Non-secret status of the alert config (channel presence + schedule). */
export function alertStatus() {
  return {
    webhook: Boolean(WEBHOOK_URL && WEBHOOK_SECRET),
    webhookUrlSet: Boolean(WEBHOOK_URL),
    webhookSecretSet: Boolean(WEBHOOK_SECRET),
    email: Boolean(EMAIL_TO && EMAIL_API_KEY && EMAIL_FROM),
    emailToSet: Boolean(EMAIL_TO),
    telegram: Boolean(TG_TOKEN && TG_CHAT_ID),
    telegramTokenSet: Boolean(TG_TOKEN),
    intervalMin: CHECK_INTERVAL_MIN,
    sportOddsTtlMin: SPORT_ODDS_TTL_MIN,
    maxSportFetchesPerScan: MAX_SPORT_FETCHES,
    indexTtlMin: INDEX_TTL_MIN,
    oddsApiKey: Boolean(ODDS_API_KEY),
    requestsRemaining: lastRequestsRemaining,
    lastScanCredits,
    // When the last scan COMPLETED — what the gap alarm measures silence against.
    lastScanAt: lastScanAt(),
    rules: {
      cash: true, // GREEN CASH — cash qualifying profit > 0
      freebet: true, // FREE BET 100%+ — SNR free bet retains more than its stake
    },
  };
}

/** Start the background worker. No-op unless at least one channel is configured. */
export function startAlertWorker(): void {
  if (!hasAlertChannel()) {
    log(
      "no alert channel configured — worker idle. Set ALERT_WEBHOOK_URL (+ALERT_WEBHOOK_SECRET), ALERT_EMAIL_TO, or ALERT_TELEGRAM_BOT_TOKEN.",
    );
    return;
  }
  const ms = CHECK_INTERVAL_MIN * 60_000;
  log(`alert worker started (every ${CHECK_INTERVAL_MIN}m, per-sport odds TTL ${SPORT_ODDS_TTL_MIN}m, max ${MAX_SPORT_FETCHES} sport fetches/scan)`);
  const tick = () => runAlertCheck().catch((e) => log(`check error: ${String(e)}`));
  setTimeout(tick, 5_000); // first check shortly after boot
  setInterval(tick, ms);
}

// CLI: `bun src/server/alerts.ts --once` runs a single check and exits.
// (Used for local end-to-end verification against a fake webhook receiver.)
if ((import.meta as { main?: boolean }).main && Bun.argv.includes("--once")) {
  logOddsKeyState("alert worker");
  runAlertCheck()
    .then((r) => {
      console.log(`ALERT_ONCE result=${JSON.stringify(r)}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`ALERT_ONCE error: ${String(e)}`);
      process.exit(1);
    });
}

// CLI: `bun src/server/alerts.ts --test-alert` sends one delivery-check message
// through the real postTelegram() path and prints the Message API result.
if ((import.meta as { main?: boolean }).main && Bun.argv.includes("--test-alert")) {
  sendTestAlert()
    .then((r) => {
      console.log(`TEST_ALERT ${JSON.stringify(r)}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`TEST_ALERT error: ${String(e)}`);
      process.exit(1);
    });
}

// CLI: `bun src/server/alerts.ts --status` prints the non-secret channel /
// schedule status (what /api/alert-status used to serve) and exits.
if ((import.meta as { main?: boolean }).main && Bun.argv.includes("--status")) {
  console.log(JSON.stringify(alertStatus()));
  process.exit(0);
}
