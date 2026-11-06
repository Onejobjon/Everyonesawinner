#!/usr/bin/env bun
/**
 * Daily-heartbeat runner — one "still alive" message a day, so that NOT getting
 * it means something.
 *
 *   bun scripts/alert-heartbeat.ts             # send today's heartbeat if due
 *   bun scripts/alert-heartbeat.ts --dry-run   # print the decision, send nothing
 *   bun scripts/alert-heartbeat.ts --verbose   # also print "not due yet" checks
 *
 * WHERE THE SCHEDULING LIVES: scripts/alert-keepalive.sh, the supervisor's 60
 * second loop, calls this on every pass. That loop is started by
 * scripts/ensure-alert-worker.sh from package.json's postinstall and predev, so
 * it is the one thing that always comes back after a machine replacement — and
 * it needs no cron, because this machine has none. The 60s tick plus the London
 * day key means the message goes out within a minute of 09:00 Europe/London, or
 * at the first tick after a boot that happens later in the day (a catch-up,
 * which is the point: a machine that was off at 09:00 still owes the owner one
 * message that day).
 *
 * THE HONEST LIMIT: this alarm runs on the machine it watches. If the machine is
 * off, nothing here runs and no message is sent — that is exactly why the
 * message exists and why its ABSENCE is the signal. A real fix is a dead-man's
 * switch outside this machine (an external scheduled check that expects a ping
 * and alerts when it stops). This repo cannot provide that on its own: it would
 * need a service with its own scheduler and its own always-on host, which we do
 * not have here. Pretending the local heartbeat is that would be worse than
 * saying so plainly, which the message does.
 *
 * Reads:
 *   .run/alerts-last-scan.json      — last completed scan (ts, alerted)
 *   .run/alerts-sports-index.json   — 26-hour coverage (sports / fixtures)
 *   .run/credits.jsonl              — last odds-API "remaining" the vendor reported
 *   .run/heartbeat.json             — this script's own state (day key + sent time)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideHeartbeat, HEARTBEAT_LOCAL_HOUR, STALE_SCAN_MIN } from "../src/server/heartbeat";
import { loadSecrets, sendSystemMessage } from "./lib/owner-dm";

const REPO = join(import.meta.dir, "..");
const RUN_DIR = process.env.ALERTS_RUN_DIR || join(REPO, ".run");
const LAST_SCAN_FILE = join(RUN_DIR, "alerts-last-scan.json");
const INDEX_FILE = join(RUN_DIR, "alerts-sports-index.json");
const CREDITS_FILE = join(RUN_DIR, "credits.jsonl");
const STATE_FILE = join(RUN_DIR, "heartbeat.json");

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

function lastScan(): { ts: string | null; alerted: number | null } {
  const raw = readJson(LAST_SCAN_FILE);
  const ts =
    typeof raw?.ts === "string" && Number.isFinite(new Date(raw.ts).getTime()) ? raw.ts : null;
  const alerted = typeof raw?.alerted === "number" ? raw.alerted : null;
  return { ts, alerted };
}

function coverage(): { sports: number | null; fixtures: number | null } {
  const index = readJson(INDEX_FILE);
  if (!index) return { sports: null, fixtures: null };
  return {
    sports: Array.isArray(index.sports) ? index.sports.length : null,
    fixtures: typeof index.totalFixturesInWindow === "number" ? index.totalFixturesInWindow : null,
  };
}

/**
 * The last odds-API credit figure ANY scan reported. credits.jsonl is
 * append-only, one line per scan, so the newest line with a numeric `remaining`
 * is the freshest thing we know. A cache-hit scan records `remaining: null`
 * because it spent nothing and learned nothing — that is why this walks
 * backwards instead of trusting the final line.
 */
function creditsRemaining(): number | null {
  if (!existsSync(CREDITS_FILE)) return null;
  try {
    const lines = readFileSync(CREDITS_FILE, "utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as { remaining?: unknown };
        if (typeof rec.remaining === "number" && Number.isFinite(rec.remaining)) return rec.remaining;
      } catch {
        /* skip a corrupt line */
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readState(): { lastSentDayKey: string | null; lastSentAt: string | null } {
  const raw = readJson(STATE_FILE);
  return {
    lastSentDayKey: typeof raw?.lastSentDayKey === "string" ? raw.lastSentDayKey : null,
    lastSentAt: typeof raw?.lastSentAt === "string" ? raw.lastSentAt : null,
  };
}

function writeState(dayKey: string, sentAt: string): void {
  if (DRY_RUN) return;
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastSentDayKey: dayKey, lastSentAt: sentAt, updatedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch (e) {
    console.error(`[heartbeat] could not write state: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  loadSecrets();
  const now = new Date();
  const state = readState();
  const scan = lastScan();

  const decision = decideHeartbeat({
    now,
    lastSentDayKey: state.lastSentDayKey,
    lastSentAt: state.lastSentAt,
    lastScanAt: scan.ts,
    coverage: coverage(),
    creditsRemaining: creditsRemaining(),
    lastScanAlerted: scan.alerted,
    staleMin: STALE_SCAN_MIN,
  });

  if (decision.action === "none") {
    if (VERBOSE) console.log(`[heartbeat] nothing to send — ${decision.reason}`);
    return;
  }

  if (DRY_RUN) {
    console.log(
      `[heartbeat] DRY RUN — would send (${decision.healthy ? "healthy" : "STALE"}, day ${decision.dayKey}):\n${decision.message}`,
    );
    return;
  }

  const sent = await sendSystemMessage(decision.message, "heartbeat");
  // State only after a confirmed delivery: a Telegram blip must not eat the day,
  // and a duplicate inside the same London day is refused by the day key.
  if (sent) writeState(decision.dayKey, now.toISOString());
  else console.error(`[heartbeat] delivery failed — will retry on the next ${HEARTBEAT_LOCAL_HOUR}:00 tick`);
}

await main();
