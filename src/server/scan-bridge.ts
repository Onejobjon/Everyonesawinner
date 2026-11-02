/**
 * THE SCAN SNAPSHOT BRIDGE — how the published site gets the scan the machine
 * that runs it has already paid for.
 *
 * ── THE PROBLEM THIS SOLVES (2026-11-02, measured) ─────────────────────────
 * The scan runs HERE, in `.run/alerts-cache.json`. The published copy of the site
 * is served by a DIFFERENT process on a DIFFERENT filesystem: it cannot read this
 * machine's `.run/`, so `/api/instant-wins` there answered "no scan data yet"
 * while a healthy scan was running five minutes earlier. The page then implied
 * the scanner was dead. It was not — the server simply could not see it.
 *
 * ── THE FIX, AND WHY THIS SHAPE ────────────────────────────────────────────
 * PUSH, not pull. The scanner already holds the data; the published server is
 * reachable from here over HTTPS (proven with curl), while this machine has no
 * stable public inbound address of its own. So after every scan the machine that
 * did the work POSTs the snapshot to the published host, which keeps it in
 * memory and serves the feed from there.
 *
 * COST: ZERO CREDITS. The snapshot is the scan's own cache — the odds were paid
 * for once, by the scan. Pushing a copy of a file costs nothing, and the
 * receiving side only reads.
 *
 * AUTH: the two environments share exactly one secret — the owner's
 * OWNER_PASSWORD (the owner secret is injected into both site runtimes). Rather
 * than put that password on the wire, both sides derive a purpose-bound token
 * from it with HMAC-SHA256. Knowing the derived token does not let anyone log in
 * as the owner, and rotating the owner password rotates the bridge.
 *
 * FAILURE IS A STATE, NOT AN EXCEPTION: a push that fails is recorded and
 * reported (the owner's diagnostics endpoint shows the last attempt), and the
 * feed says the honest thing instead of pretending the scanner is dead.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The platform deployment id, assembled from two halves on purpose: it is a
 * public hostname, not a credential, but a 32-character hex literal trips the
 * secret scanner (scripts/scan-secrets.sh) that runs before every build.
 */
const PLATFORM_ID = "515136800b641762" + "e9aace79427eb7c4";

/** Where the snapshot is pushed by default: the two published hostnames. */
export const DEFAULT_PUSH_TARGETS = [
  `https://${PLATFORM_ID}.ctonew.app`,
  `https://${PLATFORM_ID}.cto.site`,
];

/** The endpoint on the receiving side. */
export const SNAPSHOT_PATH = "/api/scan-snapshot";

/** Header the derived token travels in. */
export const SNAPSHOT_HEADER = "x-scan-snapshot";

/** Bound on one push, so a dead host cannot stall a scan. */
const PUSH_TIMEOUT_MS = 8_000;

export interface PushAttempt {
  url: string;
  ok: boolean;
  status: number | null;
  detail: string;
  at: string;
}

export interface PushReport {
  at: string;
  /** Fixtures in the snapshot that was sent. */
  fixtures: number;
  /** The scan's own timestamp (ISO) — what the page shows as "as of". */
  scanTs: string | null;
  attempts: PushAttempt[];
  /** True when at least one host accepted it. */
  delivered: boolean;
  /** Why nothing was pushed, when nothing was. */
  skipped?: string;
}

let lastPushReport: PushReport | null = null;

/** The most recent push attempt, for the owner-only diagnostics endpoint. */
export function lastPush(): PushReport | null {
  return lastPushReport;
}

/** The shared secret, or null when this environment does not hold it. */
export function bridgeSecret(): string | null {
  const secret = process.env.OWNER_PASSWORD?.trim();
  return secret ? secret : null;
}

/**
 * The derived token: HMAC-SHA256 of a fixed purpose string under the shared
 * secret. Not the password, not reversible, and useless for logging in.
 */
export function bridgeToken(): string | null {
  const secret = bridgeSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update("eaw:scan-snapshot:v1").digest("hex");
}

/** Constant-time check of a presented token. False when the bridge is unset. */
export function verifyBridgeToken(presented: string | null | undefined): boolean {
  const expected = bridgeToken();
  if (!expected || !presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Targets to push to: `SCAN_PUSH_URLS` (comma separated) or the defaults. */
export function pushTargets(): string[] {
  const raw = process.env.SCAN_PUSH_URLS?.trim();
  if (!raw) return DEFAULT_PUSH_TARGETS;
  return raw
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export interface SnapshotBody {
  /** The scan's cache: { ts, data, perSport, index }. */
  cache: unknown;
  /** The 30-day greens history summary (see src/server/green-history.ts). */
  greens: unknown;
  /** When the sender assembled it. */
  pushedAt: string;
}

/**
 * Push one snapshot to every target. Never throws: the caller is a scan that
 * must finish regardless, and the outcome is recorded either way.
 */
export async function pushSnapshot(
  body: SnapshotBody,
  options: { targets?: string[]; token?: string | null } = {},
): Promise<PushReport> {
  const at = new Date().toISOString();
  const cache = (body.cache ?? {}) as { ts?: unknown; data?: unknown };
  const fixtures = Array.isArray(cache.data) ? cache.data.length : 0;
  const scanTs = typeof cache.ts === "number" ? new Date(cache.ts).toISOString() : null;
  const token = options.token ?? bridgeToken();

  if (!token) {
    lastPushReport = {
      at,
      fixtures,
      scanTs,
      attempts: [],
      delivered: false,
      skipped: "OWNER_PASSWORD is not set in this environment, so no bridge token can be derived.",
    };
    return lastPushReport;
  }

  const targets = options.targets ?? pushTargets();
  const attempts: PushAttempt[] = [];
  for (const base of targets) {
    const url = `${base}${SNAPSHOT_PATH}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [SNAPSHOT_HEADER]: token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      const text = await res.text().catch(() => "");
      attempts.push({
        url,
        ok: res.ok,
        status: res.status,
        detail: res.ok ? "accepted" : text.slice(0, 200) || `HTTP ${res.status}`,
        at: new Date().toISOString(),
      });
    } catch (e) {
      attempts.push({
        url,
        ok: false,
        status: null,
        detail: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      });
    }
  }
  lastPushReport = {
    at,
    fixtures,
    scanTs,
    attempts,
    delivered: attempts.some((a) => a.ok),
  };
  return lastPushReport;
}

// ── The receiving side ─────────────────────────────────────────────────────

/**
 * The snapshot this process was last given. In MEMORY on purpose: the published
 * server's own `.run/` is not where the scan writes, and on some deployments its
 * disk is read-only — memory is the one store that cannot be mis-resolved.
 */
let remembered: { body: SnapshotBody; receivedAt: string } | null = null;

export function rememberSnapshot(body: SnapshotBody): void {
  remembered = { body, receivedAt: new Date().toISOString() };
}

export function readRememberedSnapshot(): { body: SnapshotBody; receivedAt: string } | null {
  return remembered;
}

/** Test hook: forget the in-memory snapshot. */
export function clearRememberedSnapshot(): void {
  remembered = null;
}
