#!/usr/bin/env bun
/**
 * Gap-alarm runner — the thing that notices the scanner has stopped.
 *
 * Run it from anywhere, as often as you like: it is idempotent and it sends AT
 * MOST one message per stall (see src/server/gap-alarm.ts for the decision).
 *
 *   bun scripts/alert-gap-alarm.ts            # check, and message once per stall
 *   bun scripts/alert-gap-alarm.ts --dry-run  # print the decision, send nothing
 *   bun scripts/alert-gap-alarm.ts --verbose  # also print "nothing to do" checks
 *
 * It is called from two places on purpose:
 *   1. scripts/alert-keepalive.sh — the supervisor's 60s loop, and
 *   2. vite.config.ts — the dev server's 60s timer, which is the only thing
 *      guaranteed to start after a machine replacement.
 * Either one surviving is enough for a stall to be announced.
 *
 * Reads (never writes) the scan's own files:
 *   .run/alerts-last-scan.json  — written by runAlertCheck() on every completed scan
 *   .run/alerts-cache.json      — fallback, the scan's odds cache
 *   .run/gap-alarm.json         — this script's own state (which stall was announced)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideGapAlarm, GAP_ALARM_MIN } from "../src/server/gap-alarm";
import { resolveChatId, systemSuppressionReason } from "../src/server/telegram-channels";

const REPO = join(import.meta.dir, "..");
const RUN_DIR = process.env.ALERTS_RUN_DIR || join(REPO, ".run");
const LAST_SCAN_FILE = join(RUN_DIR, "alerts-last-scan.json");
const CACHE_FILE = join(RUN_DIR, "alerts-cache.json");
const STATE_FILE = join(RUN_DIR, "gap-alarm.json");
const SECRETS_FILE = process.env.EAW_SECRETS_FILE || "/home/team/shared/.secrets/telegram.env";

const DRY_RUN = Bun.argv.includes("--dry-run");
const VERBOSE = Bun.argv.includes("--verbose");

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Machine uptime in ms — "has this machine even been up long enough to miss a scan?" */
function uptimeMs(): number | null {
  try {
    const first = readFileSync("/proc/uptime", "utf8").split(" ")[0];
    const seconds = Number(first);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** ISO time of the last completed scan, from either file the worker writes. */
function lastScanIso(): string | null {
  const marker = readJson(LAST_SCAN_FILE);
  const rawMarker = marker?.ts;
  if (typeof rawMarker === "string" && Number.isFinite(new Date(rawMarker).getTime())) return rawMarker;
  if (typeof rawMarker === "number" && Number.isFinite(rawMarker)) return new Date(rawMarker).toISOString();
  const cache = readJson(CACHE_FILE);
  const rawCache = cache?.ts;
  if (typeof rawCache === "number" && Number.isFinite(rawCache)) return new Date(rawCache).toISOString();
  if (typeof rawCache === "string" && Number.isFinite(new Date(rawCache).getTime())) return rawCache;
  return null;
}

/** Load the owner's Telegram credentials without ever printing them. */
function loadSecrets(): void {
  if (!existsSync(SECRETS_FILE)) return;
  try {
    for (const line of readFileSync(SECRETS_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, "").trim();
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* an unreadable secrets file is not fatal — we simply cannot send */
  }
}

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  // A stall alarm is a SYSTEM message: private admin chat only, never the
  // customer-facing alerts group, and suppressed (not redirected) when no
  // private admin chat is configured. See src/server/telegram-channels.ts.
  const chatId = resolveChatId("system");
  if (!chatId) {
    console.error(`[gap-alarm] suppressed — ${systemSuppressionReason()}; message NOT sent`);
    return false;
  }
  if (!token) {
    console.error("[gap-alarm] no Telegram credentials — message NOT sent");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;
    if (res.ok && body?.ok) {
      console.log(`[gap-alarm] telegram ok msg_id=${body.result?.message_id ?? "?"}`);
      return true;
    }
    console.error(`[gap-alarm] telegram failed: ${body?.description || `HTTP ${res.status}`}`);
    return false;
  } catch (e) {
    console.error(`[gap-alarm] telegram error: ${String(e)}`);
    return false;
  }
}

function writeState(announcedFor: string | null, note: string): void {
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ announcedFor, note, updatedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch (e) {
    console.error(`[gap-alarm] could not write state: ${String(e)}`);
  }
}

async function main(): Promise<void> {
  loadSecrets();

  const now = new Date();
  const state = readJson(STATE_FILE) ?? {};
  const announcedFor = typeof state.announcedFor === "string" ? state.announcedFor : null;

  const decision = decideGapAlarm({
    now,
    lastScanAt: lastScanIso(),
    uptimeMs: uptimeMs(),
    announcedFor,
    thresholdMin: GAP_ALARM_MIN,
  });

  if (decision.action === "alert") {
    if (DRY_RUN) {
      console.log(`[gap-alarm] DRY RUN — would send (stall ${decision.stallKey}):\n${decision.message}`);
      return;
    }
    const sent = await sendTelegram(decision.message);
    // Record the stall ONLY once it has actually been delivered — otherwise a
    // Telegram blip would silence the alarm for the rest of the stall.
    if (sent) writeState(decision.stallKey, "stall announced");
    else console.error("[gap-alarm] delivery failed — will retry on the next check");
    return;
  }

  if (decision.action === "clear") {
    if (VERBOSE) console.log(`[gap-alarm] ${decision.reason}`);
    writeState(null, decision.reason);
    return;
  }

  if (VERBOSE) console.log(`[gap-alarm] nothing to do — ${decision.reason}`);
}

await main();
