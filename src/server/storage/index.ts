/**
 * WHICH DRIVER, AND WHAT IT IS STORING.
 *
 * One env var decides: DATABASE_URL. Set it to any Postgres connection string
 * (Neon, Supabase, Vercel Postgres, a VPS box) and every customer record moves
 * to the database. Unset, the app keeps working exactly as it does today on the
 * files under `.run/` — and says so, loudly, so this never silently regresses
 * back to a store that a redeploy wipes.
 *
 * The file paths and layouts below are the ONLY place the on-disk format is
 * described, which is why the file driver can promise it has not changed:
 *   users.json              { "<email>": StoredUser }
 *   sessions.json           { "<token>": SessionRecord }
 *   comps.json              { "<email>": CompGrant }
 *   leads.json              [ LeadRecord, … ]
 *   stripe-events.json      { "events": [ {id, at, note}, … ] }
 *   affiliate-clicks.jsonl  one {slug, at, from} per line
 */
import { dirname, join } from "node:path";
import { cwdRunFile } from "../run-dir";
import { FileStore, type FileLayout } from "./file-store";
import { SqlStore } from "./sql-store";
import type { StorageBackend, Store } from "./types";

/** The one environment variable the owner sets. */
export const STORAGE_ENV_VAR = "DATABASE_URL";

/** Every store this app persists. Adding one means adding it here, and nowhere else. */
export type StoreName =
  | "users"
  | "sessions"
  | "leads"
  | "comps"
  | "stripe-events"
  | "affiliate-clicks";

export const STORE_NAMES: StoreName[] = [
  "users",
  "sessions",
  "leads",
  "comps",
  "stripe-events",
  "affiliate-clicks",
];

interface FileDef {
  file: () => string;
  layout: FileLayout;
}

const lower = (v: any): string => String(v?.email ?? "").trim().toLowerCase();

const FILE_DEFS: Record<StoreName, FileDef> = {
  users: {
    file: () => cwdRunFile(process.env.USERS_FILE, "users.json"),
    layout: { kind: "map" },
  },
  sessions: {
    file: () => cwdRunFile(process.env.SESSIONS_FILE, "sessions.json"),
    layout: { kind: "map" },
  },
  comps: {
    file: () => cwdRunFile(process.env.COMPS_FILE, "comps.json"),
    layout: { kind: "map" },
  },
  leads: {
    file: () => cwdRunFile(process.env.LEADS_FILE, "leads.json"),
    layout: { kind: "array", keyOf: lower },
  },
  "stripe-events": {
    // Beside accounts by default, `STRIPE_EVENTS_FILE` to override — unchanged.
    // Computed here rather than importing usersFile() so the storage layer does
    // not depend on the account layer (which depends on it).
    file: () => {
      const explicit = (process.env.STRIPE_EVENTS_FILE || "").trim();
      return (
        explicit || join(dirname(cwdRunFile(process.env.USERS_FILE, "users.json")), "stripe-events.json")
      );
    },
    layout: { kind: "wrapped", field: "events", keyOf: (v: any) => String(v?.id ?? "") },
  },
  "affiliate-clicks": {
    file: () => cwdRunFile(process.env.CLICKS_FILE, "affiliate-clicks.jsonl"),
    layout: {
      kind: "jsonl",
      keyOf: (v: any) => `${v?.at ?? ""}|${v?.slug ?? ""}|${v?.from ?? ""}`,
    },
  },
};

/** The configured database URL, or null. Read at call time, never cached. */
export function databaseUrl(): string | null {
  const url = (process.env[STORAGE_ENV_VAR] || "").trim();
  return url || null;
}

/** Which driver every store is using right now. */
export function storageBackend(): StorageBackend {
  return databaseUrl() ? "postgres" : "file";
}

/** True when customer data survives a redeploy. */
export function storageIsDurable(): boolean {
  return storageBackend() === "postgres";
}

const cache = new Map<string, Store<any>>();

/**
 * The store named `name`.
 *
 * Cached per (name, backend, url) so a test that flips DATABASE_URL inside one
 * process gets a fresh driver instead of a stale connection.
 */
export function store<T = unknown>(name: StoreName): Store<T> {
  announceStorageOnce();
  const url = databaseUrl();
  const cacheKey = `${name}::${url ?? "file"}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit as Store<T>;
  const created: Store<T> = url
    ? new SqlStore<T>(name)
    : new FileStore<T>({ name, ...FILE_DEFS[name] });
  cache.set(cacheKey, created);
  return created;
}

/** Drop cached drivers — used by tests that change the environment. */
export function resetStores(): void {
  cache.clear();
  warned = false;
}

// ── Saying it out loud ─────────────────────────────────────────────────────

let warned = false;

/** What a human needs to know about where customer data is going. */
export interface StorageStatus {
  backend: StorageBackend;
  /** True only when a database is configured: records survive a redeploy. */
  durable: boolean;
  envVar: string;
  /** One line, in words the owner can act on. */
  detail: string;
  stores: StoreName[];
}

export function storageStatus(env: NodeJS.ProcessEnv = process.env): StorageStatus {
  const configured = (env[STORAGE_ENV_VAR] || "").trim() !== "";
  return {
    backend: configured ? "postgres" : "file",
    durable: configured,
    envVar: STORAGE_ENV_VAR,
    detail: configured
      ? `Customer records are stored in Postgres (${STORAGE_ENV_VAR} is set) and survive a redeploy.`
      : `No database configured — customer records are files under .run/ and are LOST on the next deploy. Set ${STORAGE_ENV_VAR} to a Postgres connection string before taking any payment.`,
    stores: STORE_NAMES,
  };
}

/**
 * One startup log line, once per process, on first use of any store.
 *
 * A warning rather than a quiet note because the failure it predicts is silent:
 * everything looks fine until the next publish, and then every account is gone.
 */
export function announceStorageOnce(): void {
  if (warned) return;
  warned = true;
  const status = storageStatus();
  if (status.durable) {
    console.log(`[storage] ${status.detail}`);
  } else {
    console.warn(`[storage] ${status.detail}`);
  }
}
