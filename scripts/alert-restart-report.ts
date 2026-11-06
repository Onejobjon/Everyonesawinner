#!/usr/bin/env bun
/**
 * Restart-report runner — tells the owner the scanner was silent, and for how
 * long, the moment it comes back.
 *
 *   bun scripts/alert-restart-report.ts             # report once per gap
 *   bun scripts/alert-restart-report.ts --dry-run   # print the decision, send nothing
 *   bun scripts/alert-restart-report.ts --verbose   # also print "nothing to do" checks
 *
 * CALLED FROM scripts/alert-loop.sh, after the FIRST completed scan of a fresh
 * loop, with EAW_RESTART_AT set to the moment that loop started. After the first
 * tick on purpose: "how many opportunities have been found since the restart"
 * is only a real number once a scan has run, and a message that says "0 so far,
 * the first scan is starting now" would be a message about nothing.
 *
 * SILENT ON A ROUTINE RESTART: under 45 minutes since the last completed scan,
 * it says nothing at all (see src/server/restart-report.ts). It also records the
 * gap it has announced, so the supervisor restarting the loop twice in a minute
 * cannot produce two messages.
 *
 * IT ALSO WRITES THE LINE THAT ANSWERS "WAS THE WATCHDOG ALIVE BEFORE THE GAP?":
 * the last time scripts/alert-gap-alarm.ts actually ran, logged — never
 * messaged. If that timestamp is missing it says "unknown" rather than inventing
 * one. .run/gap-alarm.json is NOT a substitute: it is only rewritten when a stall
 * is announced or cleared, so while things are healthy it can be days old and
 * would look exactly like a dead watchdog.
 *
 * Reads (never writes) the worker's own files:
 *   .run/alerts-last-scan.json      — last completed scan (ts)
 *   .run/greens.jsonl               — opportunities found, one JSON object per line
 *   .run/alerts-sports-index.json   — 26-hour coverage (sports / fixtures)
 *   .run/gap-alarm-last-run.json    — when the stall alarm last ran
 *   .run/restart-report.json        — this script's own state (gap already reported)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideRestartReport, RESTART_GAP_MIN, stampLabel } from "../src/server/restart-report";
import { loadSecrets, sendSystemMessage } from "./lib/owner-dm";

const REPO = join(import.meta.dir, "..");
const RUN_DIR = process.env.ALERTS_RUN_DIR || join(REPO, ".run");
const LAST_SCAN_FILE = join(RUN_DIR, "alerts-last-scan.json");
const GREENS_FILE = join(RUN_DIR, "greens.jsonl");
const INDEX_FILE = join(RUN_DIR, "alerts-sports-index.json");
const GAP_ALARM_RUN_FILE = join(RUN_DIR, "gap-alarm-last-run.json");
const STATE_FILE = join(RUN_DIR, "restart-report.json");

const DRY_RUN = Bun.argv.includes("--dry-run");
const VERBOSE = Bun.argv.includes("--verbose");

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** ISO time of the last completed scan, or null. */
function lastScanIso(): string | null {
  const raw = readJson(LAST_SCAN_FILE)?.ts;
  if (typeof raw === "string" && Number.isFinite(new Date(raw).getTime())) return raw;
  return null;
}

/** When this scan loop started: the loop's own timestamp, else the machine's boot time. */
function restartIso(now: Date): string | null {
  const fromLoop = (process.env.EAW_RESTART_AT || "").trim();
  if (fromLoop && Number.isFinite(new Date(fromLoop).getTime())) return fromLoop;
  try {
    const seconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (Number.isFinite(seconds)) return new Date(now.getTime() - seconds * 1000).toISOString();
  } catch {
    /* not Linux, or unreadable — fall through */
  }
  return null;
}

/**
 * Green-cash opportunities recorded since the restart. Read from greens.jsonl,
 * which the scan appends to (src/server/green-history.ts) — the same file the
 * dashboard's Instant Wins reads, so the count is the owner's own number rather
 * than a second opinion. null (never 0) when the file or the restart time is
 * unknown: "0" would be a claim we cannot support.
 */
function foundSinceRestart(restartAt: string | null): number | null {
  if (!restartAt) return null;
  if (!existsSync(GREENS_FILE)) return 0;
  const from = new Date(restartAt).getTime();
  if (!Number.isFinite(from)) return null;
  let count = 0;
  try {
    for (const line of readFileSync(GREENS_FILE, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { ts?: unknown };
        const ts = typeof rec.ts === "string" ? new Date(rec.ts).getTime() : NaN;
        if (Number.isFinite(ts) && ts >= from) count++;
      } catch {
        /* a corrupt line is skipped, exactly as green-history.ts does */
      }
    }
  } catch {
    return null;
  }
  return count;
}

/** Sports/fixtures inside the rolling 26-hour window, from the surviving index. */
function coverage(): { sports: number | null; fixtures: number | null } {
  const index = readJson(INDEX_FILE);
  if (!index) return { sports: null, fixtures: null };
  const sports = Array.isArray(index.sports) ? index.sports.length : null;
  const fixtures =
    typeof index.totalFixturesInWindow === "number" ? index.totalFixturesInWindow : null;
  return { sports, fixtures };
}

/** When the stall alarm itself last ran, or null when there is no record. */
function stallAlarmLastRunIso(): string | null {
  const raw = readJson(GAP_ALARM_RUN_FILE)?.ts;
  if (typeof raw === "string" && Number.isFinite(new Date(raw).getTime())) return raw;
  return null;
}

function readState(): { reportedFor: string | null } {
  const raw = readJson(STATE_FILE)?.reportedFor;
  return { reportedFor: typeof raw === "string" ? raw : null };
}

function writeState(reportedFor: string | null, note: string): void {
  if (DRY_RUN) return;
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ reportedFor, note, updatedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch (e) {
    console.error(`[restart-report] could not write state: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  loadSecrets();
  const now = new Date();

  const lastScanAt = lastScanIso();
  const restartAt = restartIso(now);
  const alarmLastRun = stallAlarmLastRunIso();
  const state = readState();

  // ALWAYS logged, whether or not a message goes out: this is the evidence that
  // answers "was the watchdog alive before the gap?" after the fact. Not a
  // message — the owner asked for the log line, not another notification.
  console.log(
    `[restart-report ${now.toISOString()}] scan loop started` +
      (restartAt ? ` at ${restartAt}` : " (restart time unknown)") +
      `; stall alarm last ran: ` +
      (alarmLastRun ? `${alarmLastRun} (${stampLabel(alarmLastRun, now)})` : "unknown — no record"),
  );

  const decision = decideRestartReport({
    now,
    lastScanAt,
    restartAt,
    foundSinceRestart: foundSinceRestart(restartAt),
    coverage: coverage(),
    stallAlarmLastRunAt: alarmLastRun,
    reportedFor: state.reportedFor,
    thresholdMin: RESTART_GAP_MIN,
  });

  if (decision.action === "none") {
    // A scan has landed since the last reported gap: clear the state so the NEXT
    // outage gets its own message. Only when we are under the threshold — a
    // "already reported" answer must leave the record alone.
    if (decision.reason.includes("under the")) writeState(null, decision.reason);
    if (VERBOSE) console.log(`[restart-report] nothing to send — ${decision.reason}`);
    return;
  }

  if (DRY_RUN) {
    console.log(`[restart-report] DRY RUN — would send (gap ${decision.gapKey}):\n${decision.message}`);
    return;
  }

  const sent = await sendSystemMessage(decision.message, "restart-report");
  // Record the gap ONLY once it has actually been delivered: a Telegram blip must
  // not silence the report for the rest of the outage.
  if (sent) writeState(decision.gapKey, `gap reported (${decision.gapMinutes ?? "unknown"} min)`);
  else console.error("[restart-report] delivery failed — will retry on the next tick");
}

await main();
