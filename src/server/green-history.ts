/**
 * GREEN HISTORY — a small record of the green trades the scan has actually found.
 *
 * WHY (owner, 2026-11-02): greens are rare. On a quiet day the live feed is empty
 * and an empty feed undersells what the subscription is for. This file is the
 * proof: every green the scan sees is appended once, so the page can say "we have
 * found N in the last 30 days, the best returned £X on a £20 stake" even when
 * today's list happens to be empty.
 *
 * THREE RULES, and they are the whole module:
 *  1. NOTHING COSTS A CREDIT. A record is written from a row that already passed
 *     through a scan; this file never fetches anything.
 *  2. ONLY GREENS ENTER. `recordGreens` re-runs the SHARED `calcLay` at the
 *     reference stake and commission and drops anything that is not profitable
 *     on both sides — the caller cannot leak a qualifying-grade row in, even by
 *     mistake. (That is the Cameron Norrie 1.44/1.46 case: a −£0.40 loss.)
 *  3. THE SAME OPPORTUNITY IS ONE ENTRY. A scan runs every ten minutes, so the
 *     same green is seen over and over. A row is a duplicate when the same match,
 *     outcome, bookmaker, back price, exchange and lay price were already
 *     recorded inside DEDUPE_WINDOW_HOURS; a genuinely re-priced row is new.
 *
 * The file is JSONL (one record per line) at `.run/greens.jsonl`, append-only, so
 * a corrupt line can never destroy the rest of the history.
 */
import { existsSync, readFileSync } from "node:fs";
import { alertsRunFile, appendRunFile } from "./run-dir";
import { dirname, join } from "node:path";
import { calcLay, DEFAULT_COMMISSION, round2 } from "../lib/odds";

/** The stake every figure in the history is quoted at. */
export const REFERENCE_STAKE = 20;

/** A repeat of the same trade inside this window is the same opportunity. */
export const DEDUPE_WINDOW_HOURS = 24;

/** How far back the page looks. */
export const HISTORY_WINDOW_DAYS = 30;

export interface GreenRecord {
  /** When the scan first saw it (ISO). */
  ts: string;
  sport: string;
  match: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  /** The exchange laid against it (null when the feed did not say). */
  exchange: string | null;
  layOdds: number;
  /** The worse of the two outcomes at REFERENCE_STAKE — positive by definition. */
  profitAt20: number;
  /** Exchange commission the figure was computed at, as a percentage. */
  commissionPct: number;
}

/** What a caller (the scan) hands over for each green row it found. */
export interface GreenCandidate {
  sport?: string | null;
  match: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  exchange?: string | null;
  layOdds: number;
  /** Exchange commission as a fraction (0.02 = 2%). */
  commission?: number;
  /** "Now" — injectable so a test can control the clock. */
  now?: Date;
}

export function greenHistoryFile(): string {
  // Same rule as the alert worker: GREENS_FILE wins, else the run directory —
  // which under a test runner is a temp dir (src/server/run-dir.ts).
  return alertsRunFile(process.env.GREENS_FILE, "greens.jsonl");
}

/** Read every record on disk, skipping anything malformed. */
export function loadGreenHistory(file = greenHistoryFile()): GreenRecord[] {
  if (!existsSync(file)) return [];
  const out: GreenRecord[] = [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<GreenRecord>;
      if (
        typeof parsed?.ts === "string" &&
        typeof parsed.match === "string" &&
        typeof parsed.outcome === "string" &&
        typeof parsed.backOdds === "number" &&
        typeof parsed.layOdds === "number" &&
        typeof parsed.profitAt20 === "number" &&
        parsed.profitAt20 > 0
      ) {
        out.push({
          ts: parsed.ts,
          sport: typeof parsed.sport === "string" ? parsed.sport : "",
          match: parsed.match,
          outcome: parsed.outcome,
          bookmaker: typeof parsed.bookmaker === "string" ? parsed.bookmaker : "",
          backOdds: parsed.backOdds,
          exchange: typeof parsed.exchange === "string" ? parsed.exchange : null,
          layOdds: parsed.layOdds,
          profitAt20: parsed.profitAt20,
          commissionPct: typeof parsed.commissionPct === "number" ? parsed.commissionPct : 2,
        });
      }
    } catch {
      /* one bad line is not the history */
    }
  }
  return out;
}

/** Identity of an opportunity, independent of when it was seen. */
export function greenKey(r: {
  match: string;
  outcome: string;
  bookmaker: string;
  backOdds: number;
  exchange?: string | null;
  layOdds: number;
}): string {
  return [
    r.match.trim().toLowerCase(),
    r.outcome.trim().toLowerCase(),
    r.bookmaker.trim().toLowerCase(),
    r.backOdds.toFixed(2),
    (r.exchange ?? "").trim().toLowerCase(),
    r.layOdds.toFixed(2),
  ].join("|");
}

/**
 * Append the greens from one scan. Returns how many were written and how many
 * were dropped as repeats, so the scan log can show both.
 *
 * A candidate that is not green at REFERENCE_STAKE / its own commission is
 * dropped here — that is rule 2, enforced at the boundary rather than trusted
 * from the caller.
 */
export function recordGreens(
  candidates: readonly GreenCandidate[],
  options: { file?: string; now?: Date } = {},
): { appended: number; duplicates: number; notGreen: number } {
  const file = options.file ?? greenHistoryFile();
  const now = options.now ?? new Date();
  const existing = loadGreenHistory(file);
  const seen = new Map<string, number>();
  for (const r of existing) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) seen.set(greenKey(r), Math.max(seen.get(greenKey(r)) ?? 0, t));
  }

  const windowMs = DEDUPE_WINDOW_HOURS * 3600_000;
  const fresh: GreenRecord[] = [];
  let duplicates = 0;
  let notGreen = 0;

  for (const c of candidates) {
    const commission = Number.isFinite(c.commission) ? Number(c.commission) : DEFAULT_COMMISSION;
    const back = Number(c.backOdds);
    const lay = Number(c.layOdds);
    const money = calcLay(back, lay, REFERENCE_STAKE, commission as number);
    // NOT GREEN — the shared calculator says this loses money on one side. It
    // must never appear in a file the page presents as proof of winnings.
    if (!money || !(money.profitLoss > 0)) {
      notGreen++;
      continue;
    }
    const key = greenKey({
      match: c.match,
      outcome: c.outcome,
      bookmaker: c.bookmaker,
      backOdds: back,
      exchange: c.exchange,
      layOdds: lay,
    });
    const last = seen.get(key);
    if (last != null && now.getTime() - last < windowMs) {
      duplicates++;
      continue;
    }
    seen.set(key, now.getTime());
    fresh.push({
      ts: now.toISOString(),
      sport: c.sport ?? "",
      match: c.match,
      outcome: c.outcome,
      bookmaker: c.bookmaker,
      backOdds: round2(back),
      exchange: c.exchange ?? null,
      layOdds: round2(lay),
      profitAt20: round2(money.profitLoss),
      commissionPct: Math.round((commission as number) * 1000) / 10,
    });
  }

  if (fresh.length > 0) {
    try {
      appendRunFile(file, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch {
      // A failed write must not take a scan down; the count is reported anyway
      // so the log can show that nothing was stored.
      return { appended: 0, duplicates, notGreen };
    }
  }
  return { appended: fresh.length, duplicates, notGreen };
}

export interface GreenHistorySummary {
  /** Days the window covers — printed on the page, so it cannot drift. */
  windowDays: number;
  count: number;
  /** The best single green in the window, or null when there are none. */
  best: GreenRecord | null;
  /** Newest first, for the small list under the feed. */
  entries: GreenRecord[];
}

/**
 * The window the page shows: greens in the last `days`, newest first, plus the
 * best one. Zero is a real answer and is returned as 0 — never padded.
 */
export function readGreenHistory(
  options: { days?: number; file?: string; now?: Date; limit?: number } = {},
): GreenHistorySummary {
  const days = options.days ?? HISTORY_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - days * 24 * 3600_000;
  const inWindow = loadGreenHistory(options.file ?? greenHistoryFile()).filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= cutoff && t <= now.getTime();
  });
  // Newest first; the best is the largest profit, with the newest breaking a tie.
  inWindow.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  let best: GreenRecord | null = null;
  for (const r of inWindow) {
    if (!best || r.profitAt20 > best.profitAt20) best = r;
  }
  return {
    windowDays: days,
    count: inWindow.length,
    best,
    entries: inWindow.slice(0, options.limit ?? 5),
  };
}
