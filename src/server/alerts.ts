/**
 * Opportunity alert worker — server-side (Bun runtime only).
 *
 * Watches for profitable lay-bet opportunities using the SAME filter as the
 * /lay-bets Lay Bet Finder (back odds < 2.8, lay gap < 0.1) but only fires an
 * alert when the opportunity is genuinely PROFITABLE (expectedProfit > 0).
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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { transformMatches, type Match, type MatchOutcome } from "../lib/odds-api";
import { ODDS_API_KEY } from "./odds-key";
import { calcLay, calcFreeBetProfit, qualifiesForLay, layGap, round2 } from "../lib/odds";

const BASE = "https://api.the-odds-api.com/v4";
const REGIONS = "uk";
const MARKETS = "h2h,h2h_lay";
const BACK_STAKE = 20;

// Free-bet freshness guard: skip a freebet row unless the back and lay prices
// were last updated within this window of each other. Stale or sparse exchange
// lay data (e.g. minor-league ice hockey) can show lay < back, which would
// otherwise fire fake "free bet >100%" alerts. The cash rule is unaffected —
// its tight close-lay gap already bounds the harm.
const FRESHNESS_MAX_GAP_MS = 60 * 60_000; // 60 minutes

// ── Config (all env-var driven, safe defaults) ─────────────────────────────
// How often the worker runs a check (minutes). Default 180 = every 3h.
const CHECK_INTERVAL_MIN = num(process.env.ALERT_CHECK_INTERVAL_MIN, 180);
// How long a fetched odds snapshot stays "fresh" before the worker re-fetches.
const CACHE_TTL_MIN = num(process.env.ALERT_CACHE_TTL_MIN, 120);

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

const RUN_DIR = join(import.meta.dir, "../../.run");
const CACHE_FILE = join(RUN_DIR, "alerts-cache.json");
const SEEN_FILE = join(RUN_DIR, "alerts-seen.json");
const LOG_FILE = join(RUN_DIR, "alerts.log");
const SEEN_MAX = 4000; // cap the persisted dedup set so it can't grow unbounded

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

async function fetchRawMatches(): Promise<unknown[]> {
  const url = `${BASE}/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=${REGIONS}&markets=${MARKETS}&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) {
    const why =
      res.status === 401 ? " (401 — ODDS_API_KEY rejected)"
      : res.status === 429 ? " (429 — quota exceeded)"
      : "";
    throw new Error(`odds API ${res.status}${why}`);
  }
  return (await res.json()) as unknown[];
}

async function getMatches(): Promise<Match[]> {
  // Reuse a fresh on-disk cache instead of spending quota on every check.
  try {
    if (existsSync(CACHE_FILE)) {
      const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as {
        ts: number;
        data: Match[];
      };
      if (Date.now() - cached.ts < CACHE_TTL_MIN * 60_000) {
        return cached.data;
      }
    }
  } catch {
    /* stale/corrupt cache — just refetch */
  }

  const raw = await fetchRawMatches();
  const matches = transformMatches(raw as Parameters<typeof transformMatches>[0]);

  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data: matches }));
  } catch (e) {
    log(`cache write failed: ${String(e)}`);
  }
  return matches;
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

export function findOpportunities(
  matches: Match[]
): { opps: Opportunity[]; skippedSuspects: number } {
  const opps: Opportunity[] = [];
  let skippedSuspects = 0;
  for (const m of matches) {
    for (const o of m.outcomes) {
      const back = o.odds;
      const lay = o.layOdds;
      if (!lay) continue;

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
        gap: layGap(back, lay),
        detectedAt: new Date().toISOString(),
      };

      // GREEN CASH — existing close-lay qualifying profit (back < 2.8, gap < 0.1).
      if (qualifiesForLay(back, lay)) {
        const c = calcLay(back, lay, BACK_STAKE);
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
      const fb = calcFreeBetProfit(back, lay, BACK_STAKE);
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
  return { opps, skippedSuspects };
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

function emailText(o: Opportunity): string {
  const lines = [
    o.type === "cash"
      ? "Everyone's A Winner — GREEN CASH lay-bet opportunity"
      : "Everyone's A Winner — FREE BET 100%+ opportunity",
    "",
    `Match: ${o.match} (${o.league})`,
    `Kickoff: ${o.kickoff}`,
    `Back: ${o.outcome} @ ${o.backOdds.toFixed(2)} (${o.bookmaker})`,
    `Lay: ${o.layOdds.toFixed(2)} — gap ${o.gap.toFixed(2)}`,
  ];
  if (o.type === "cash") {
    lines.push(
      `Lay stake: £${o.layStake.toFixed(2)} | Liability: £${o.liability.toFixed(2)}`,
      `Expected profit: +£${o.expectedProfit.toFixed(2)}`,
    );
  } else {
    lines.push(
      `Free bet £${BACK_STAKE} retains £${o.freeBetProfit.toFixed(2)} (${o.retentionPct}%)`,
    );
  }
  lines.push(`Detected: ${o.detectedAt}`, "", "Alert feed only — no bet is placed for you.");
  return lines.join("\n");
}

export function telegramText(o: Opportunity): string {
  // Owner format — max two short lines, one alert. League, lay stake,
  // liability, gap and detected-at are deliberately omitted (the webhook
  // payload keeps full data for automation).
  const line1 =
    o.type === "cash"
      ? `💰 GREEN CASH — ${o.outcome} @ ${o.backOdds.toFixed(2)} back / ${o.layOdds.toFixed(2)} lay — £${BACK_STAKE} → ~£${o.expectedProfit.toFixed(2)}`
      : `🎯 FREE BET 100%+ — ${o.outcome} @ ${o.backOdds.toFixed(2)} back / ${o.layOdds.toFixed(2)} lay — £${BACK_STAKE} free bet → £${o.freeBetProfit.toFixed(2)} (${o.retentionPct}%)`;
  const line2 = `${o.home} v ${o.away} · ${o.bookmaker} · kicks off ${o.kickoffTime} · odds move fast`;
  return [line1, line2].join("\n");
}

async function deliver(o: Opportunity): Promise<void> {
  // A — webhook with HMAC-SHA256 signature
  if (WEBHOOK_URL && WEBHOOK_SECRET) {
    const body = JSON.stringify(payloadFor(o));
    const sig = await hmacSha256Hex(WEBHOOK_SECRET, body);
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": `sha256=${sig}`,
        "x-eaw-timestamp": o.detectedAt,
      },
      body,
    });
  } else if (WEBHOOK_URL && !WEBHOOK_SECRET) {
    log("ALERT_WEBHOOK_URL set but ALERT_WEBHOOK_SECRET missing — webhook skipped");
  }

  // B — email
  if (EMAIL_TO && EMAIL_API_KEY && EMAIL_FROM) {
    await fetch("https://api.resend.com/emails", {
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
  } else if (EMAIL_TO && !(EMAIL_API_KEY && EMAIL_FROM)) {
    log("ALERT_EMAIL_TO set but ALERT_EMAIL_API_KEY/ALERT_EMAIL_FROM missing — email skipped");
  }

  // C — Telegram (optional)
  if (TG_TOKEN && TG_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: telegramText(o) }),
    });
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

export async function runAlertCheck(): Promise<{
  checked: number;
  alerted: number;
  skippedSuspects: number;
}> {
  const matches = await getMatches();
  const { opps, skippedSuspects } = findOpportunities(matches);
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
  const cash = opps.filter((o) => o.type === "cash").length;
  const freebet = opps.length - cash;
  log(
    `check done: ${cash} green-cash + ${freebet} freebet, ${alerted} newly alerted, ${skippedSuspects} suspect rows skipped`
  );
  return { checked: opps.length, alerted, skippedSuspects };
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
    cacheTtlMin: CACHE_TTL_MIN,
    oddsApiKey: Boolean(ODDS_API_KEY),
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
  log(`alert worker started (every ${CHECK_INTERVAL_MIN}m, cache TTL ${CACHE_TTL_MIN}m)`);
  const tick = () => runAlertCheck().catch((e) => log(`check error: ${String(e)}`));
  setTimeout(tick, 5_000); // first check shortly after boot
  setInterval(tick, ms);
}

// CLI: `bun src/server/alerts.ts --once` runs a single check and exits.
// (Used for local end-to-end verification against a fake webhook receiver.)
if ((import.meta as { main?: boolean }).main && Bun.argv.includes("--once")) {
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
