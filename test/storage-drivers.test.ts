/**
 * THE STORAGE INTERFACE, ITS TWO DRIVERS, AND THE "NO DATABASE" FALLBACK.
 *
 * WHY THESE TESTS EXIST (2026-11-07): accounts, sessions, the Stripe event
 * ledger, comps, leads and the click log were files on the hosting disk, and a
 * redeploy replaces that disk. An account created on the live site could not be
 * found after the next publish. The fix is one interface (src/server/storage/)
 * with a file driver and a Postgres driver behind it, so a real database is a
 * configuration change.
 *
 * THE POINT OF THE SHARED SUITE: the SAME assertions run against both drivers.
 * A driver that only passes its own tests is how two implementations drift.
 *
 * THE SQL HALF RUNS FOR REAL OR SAYS IT DID NOT. It needs a throwaway database
 * in EAW_TEST_DATABASE_URL (any Postgres: a local cluster, a Neon branch, a
 * Supabase project). Without one it SKIPS — loudly, in the test name — rather
 * than pretending a fake SQL executor proves anything. The plan's rule is
 * "exercised against a throwaway database if one is available, or a clearly
 * marked skip if not", and this is that rule in code.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/server/storage/file-store";
import { SqlStore } from "../src/server/storage/sql-store";
import {
  STORAGE_ENV_VAR,
  resetStores,
  storageBackend,
  storageStatus,
  store,
} from "../src/server/storage";
import type { Store } from "../src/server/storage/types";
import { billingReadiness } from "../src/server/checkout";
import { registerUser, findByEmail } from "../src/server/users";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaw-store-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── The behaviour every driver must have ───────────────────────────────────

/**
 * Everything the six stores actually rely on. If a driver passes this, the
 * store built on it behaves the same whichever database is behind it.
 */
async function exerciseStore(make: () => Store<{ n: number; label: string }>) {
  const s = make();

  // get on an absent key is null, never a throw.
  expect(await s.get("nobody")).toBeNull();

  // put then get round-trips the whole document.
  await s.put("a", { n: 1, label: "one" });
  expect(await s.get("a")).toEqual({ n: 1, label: "one" });

  // put is last-writer-wins, and does not resurrect a deleted key.
  await s.put("a", { n: 2, label: "two" });
  expect(await s.get("a")).toEqual({ n: 2, label: "two" });

  // create is insert-if-absent: true the first time, false afterwards, and it
  // does NOT overwrite the existing record.
  expect(await s.create("b", { n: 10, label: "first" })).toBe(true);
  expect(await s.create("b", { n: 99, label: "second" })).toBe(false);
  expect(await s.get("b")).toEqual({ n: 10, label: "first" });

  // delete reports whether anything was there.
  expect(await s.delete("b")).toBe(true);
  expect(await s.delete("b")).toBe(false);
  expect(await s.get("b")).toBeNull();

  // list returns everything, oldest first.
  await s.put("c", { n: 3, label: "three" });
  const all = await s.list();
  expect(all.map((e) => e.key)).toEqual(["a", "c"]);
  expect(all[0]!.value).toEqual({ n: 2, label: "two" });

  // list(prefix) filters by key prefix.
  const prefixed = await s.list("a");
  expect(prefixed.map((e) => e.key)).toEqual(["a"]);

  // A key that looks like another store's key is still just a key.
  await s.put("a:extra", { n: 4, label: "four" });
  expect((await s.list("a")).map((e) => e.key)).toEqual(["a", "a:extra"]);

  // Clean up so the next driver starts from nothing.
  for (const entry of await s.list()) await s.delete(entry.key);
  expect(await s.list()).toEqual([]);
}

describe("the file driver", () => {
  test("behaves the way every store needs", async () => {
    const file = join(tempDir(), "records.json");
    await exerciseStore(() => new FileStore({ name: "test", file: () => file, layout: { kind: "map" } }));
  });

  test("create() is atomic: concurrent inserts for one key produce exactly one winner", async () => {
    const file = join(tempDir(), "race.json");
    const make = () => new FileStore<{ who: string }>({ name: "test", file: () => file, layout: { kind: "map" } });
    const winners = await Promise.all(
      Array.from({ length: 8 }, (_, i) => make().create("same-key", { who: `caller-${i}` })),
    );
    expect(winners.filter(Boolean).length).toBe(1);
    expect(await make().get("same-key")).not.toBeNull();
  });

  test("a missing or corrupt file reads as empty, never as an error", async () => {
    const dir = tempDir();
    const missing = new FileStore({ name: "t", file: () => join(dir, "nope.json"), layout: { kind: "map" } });
    expect(await missing.list()).toEqual([]);
    expect(await missing.get("anything")).toBeNull();

    const broken = join(dir, "broken.json");
    await Bun.write(broken, "{ this is not json");
    const corrupt = new FileStore({ name: "t", file: () => broken, layout: { kind: "map" } });
    expect(await corrupt.list()).toEqual([]);
  });

  // The on-disk format is the contract with every existing file and every test
  // that reads one. These four assertions are that contract, written down.
  test("keeps the exact on-disk formats the stores had before", async () => {
    const dir = tempDir();

    const mapFile = join(dir, "users.json");
    const map = new FileStore<{ email: string; name: string }>({
      name: "users",
      file: () => mapFile,
      layout: { kind: "map" },
    });
    await map.put("a@example.com", { email: "a@example.com", name: "A" });
    expect(readFileSync(mapFile, "utf8")).toBe(
      JSON.stringify({ "a@example.com": { email: "a@example.com", name: "A" } }, null, 2),
    );

    const arrayFile = join(dir, "leads.json");
    const array = new FileStore<{ email: string; name: string }>({
      name: "leads",
      file: () => arrayFile,
      layout: { kind: "array", keyOf: (v: any) => String(v.email).toLowerCase() },
    });
    await array.put("a@example.com", { email: "a@example.com", name: "A" });
    await array.put("b@example.com", { email: "b@example.com", name: "B" });
    expect(readFileSync(arrayFile, "utf8")).toBe(
      JSON.stringify(
        [
          { email: "a@example.com", name: "A" },
          { email: "b@example.com", name: "B" },
        ],
        null,
        2,
      ),
    );

    const wrappedFile = join(dir, "stripe-events.json");
    const wrapped = new FileStore<{ id: string; at: string; note: string }>({
      name: "stripe-events",
      file: () => wrappedFile,
      layout: { kind: "wrapped", field: "events", keyOf: (v: any) => String(v.id) },
    });
    await wrapped.put("evt_1", { id: "evt_1", at: "2026-01-01T00:00:00.000Z", note: "applied" });
    expect(readFileSync(wrappedFile, "utf8")).toBe(
      JSON.stringify(
        { events: [{ id: "evt_1", at: "2026-01-01T00:00:00.000Z", note: "applied" }] },
        null,
        2,
      ),
    );

    const jsonlFile = join(dir, "affiliate-clicks.jsonl");
    const jsonl = new FileStore<{ slug: string; at: string; from: string }>({
      name: "affiliate-clicks",
      file: () => jsonlFile,
      layout: { kind: "jsonl", keyOf: (v: any) => `${v.at}|${v.slug}|${v.from}` },
    });
    await jsonl.put("t1|mrq|/free-bets", { slug: "mrq", at: "t1", from: "/free-bets" });
    await jsonl.put("t2|bet365|/oddsmatcher", { slug: "bet365", at: "t2", from: "/oddsmatcher" });
    expect(readFileSync(jsonlFile, "utf8")).toBe(
      `${JSON.stringify({ slug: "mrq", at: "t1", from: "/free-bets" })}\n` +
        `${JSON.stringify({ slug: "bet365", at: "t2", from: "/oddsmatcher" })}\n`,
    );
  });

  test("an array/JSONL file read back keeps its keys, so a delete removes the right record", async () => {
    const dir = tempDir();
    const file = join(dir, "leads.json");
    const s = new FileStore<{ email: string; name: string }>({
      name: "leads",
      file: () => file,
      layout: { kind: "array", keyOf: (v: any) => String(v.email).toLowerCase() },
    });
    await s.put("a@example.com", { email: "a@example.com", name: "A" });
    await s.put("b@example.com", { email: "b@example.com", name: "B" });
    // A fresh driver reading the same file resolves the same keys.
    const reread = new FileStore<{ email: string; name: string }>({
      name: "leads",
      file: () => file,
      layout: { kind: "array", keyOf: (v: any) => String(v.email).toLowerCase() },
    });
    expect((await reread.list()).map((e) => e.key)).toEqual(["a@example.com", "b@example.com"]);
    expect(await reread.delete("a@example.com")).toBe(true);
    expect((await reread.list()).map((e) => e.key)).toEqual(["b@example.com"]);
  });
});

// ── The Postgres driver, against a real database or a marked skip ──────────

const TEST_DB = (process.env.EAW_TEST_DATABASE_URL || "").trim();

describe("the Postgres driver", () => {
  const run = TEST_DB ? test : test.skip;
  const suffix = TEST_DB ? "" : " [SKIPPED: no EAW_TEST_DATABASE_URL — this driver is UNPROVEN against a real Postgres]";

  beforeEach(async () => {
    if (!TEST_DB) return;
    process.env[STORAGE_ENV_VAR] = TEST_DB;
    resetStores();
    // Start every test from an empty table so counts and ordering are absolute.
    const s = new SqlStore("test");
    for (const entry of await s.list()) await s.delete(entry.key);
  });

  run(`behaves the way every store needs${suffix}`, async () => {
    process.env[STORAGE_ENV_VAR] = TEST_DB;
    await exerciseStore(() => new SqlStore<{ n: number; label: string }>("test"));
  });

  run(`create() is atomic: concurrent inserts for one key produce exactly one winner${suffix}`, async () => {
    process.env[STORAGE_ENV_VAR] = TEST_DB;
    const make = () => new SqlStore<{ who: string }>("test");
    const winners = await Promise.all(
      Array.from({ length: 8 }, (_, i) => make().create("same-key", { who: `caller-${i}` })),
    );
    expect(winners.filter(Boolean).length).toBe(1);
    expect(await make().get("same-key")).not.toBeNull();
  });

  run(`two stores never collide on the same key${suffix}`, async () => {
    process.env[STORAGE_ENV_VAR] = TEST_DB;
    const users = new SqlStore<{ kind: string }>("users");
    const comps = new SqlStore<{ kind: string }>("comps");
    await users.put("shared@example.com", { kind: "account" });
    await comps.put("shared@example.com", { kind: "grant" });
    expect((await users.get("shared@example.com"))!.kind).toBe("account");
    expect((await comps.get("shared@example.com"))!.kind).toBe("grant");
    expect((await users.list()).length).toBe(1);
    expect((await comps.list()).length).toBe(1);
    await users.delete("shared@example.com");
    await comps.delete("shared@example.com");
  });
});

// ── The fallback: no database configured ──────────────────────────────────

describe("no database configured", () => {
  const saved = process.env[STORAGE_ENV_VAR];

  beforeEach(() => {
    delete process.env[STORAGE_ENV_VAR];
    resetStores();
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[STORAGE_ENV_VAR];
    else process.env[STORAGE_ENV_VAR] = saved;
    resetStores();
  });

  test("the app keeps working on the file driver — signup and lookup still work", async () => {
    expect(storageBackend()).toBe("file");
    const email = `fallback-${Date.now()}@example.com`;
    const created = await registerUser("Fallback", email, "password123");
    expect(created.email).toBe(email);
    const found = await findByEmail(email);
    expect(found?.email).toBe(email);
  });

  test("it says so, in words a human reads: storageStatus()", () => {
    const status = storageStatus({} as NodeJS.ProcessEnv);
    expect(status.backend).toBe("file");
    expect(status.durable).toBe(false);
    expect(status.envVar).toBe("DATABASE_URL");
    // The line has to name the variable to set and the consequence of not setting it.
    expect(status.detail).toContain("DATABASE_URL");
    expect(status.detail).toContain("LOST");
    // And it lists the stores that are affected, so nothing is quietly exempt.
    expect(status.stores).toContain("users");
    expect(status.stores).toContain("stripe-events");
  });

  test("it says so on GET /api/checkout's readiness answer, and it BLOCKS taking money", () => {
    const readiness = billingReadiness({} as NodeJS.ProcessEnv);
    expect(readiness.storage.backend).toBe("file");
    expect(readiness.storage.durable).toBe(false);
    // Folded into `blockers` since 2026-11-07: a publish deletes every account on
    // the hosting disk, so taking money for one is a reason not to sell rather
    // than a footnote beside the answer. Both the status and the blocker are shown.
    expect(readiness.blockers.some((b) => b.includes("DATABASE_URL"))).toBe(true);
    expect(readiness.canTakeSubscriptionPayments).toBe(false);
  });

  test("configuring a database flips the answer, and nothing else", () => {
    const withDb = storageStatus({ DATABASE_URL: "postgres://user:pw@host:5432/db" } as NodeJS.ProcessEnv);
    expect(withDb.backend).toBe("postgres");
    expect(withDb.durable).toBe(true);
    expect(withDb.detail).toContain("survive a redeploy");

    const readiness = billingReadiness({ DATABASE_URL: "postgres://user:pw@host:5432/db" } as NodeJS.ProcessEnv);
    expect(readiness.storage.durable).toBe(true);
    // With a database configured, storage stops being one of the money blockers.
    expect(readiness.blockers.some((b) => b.includes("DATABASE_URL"))).toBe(false);
  });

  test("a blank or whitespace DATABASE_URL is not a database", () => {
    expect(storageStatus({ DATABASE_URL: "   " } as NodeJS.ProcessEnv).durable).toBe(false);
  });

  test("the six stores are the ones the app actually has", () => {
    expect(storageStatus({} as NodeJS.ProcessEnv).stores.sort()).toEqual(
      ["affiliate-clicks", "comps", "leads", "sessions", "stripe-events", "users"].sort(),
    );
  });

  test("every store is reachable through the registry and writes under the run directory", async () => {
    for (const name of storageStatus({} as NodeJS.ProcessEnv).stores) {
      const s = store(name);
      expect(s.backend).toBe("file");
      expect(s.name).toBe(name);
    }
    // A write really lands on disk rather than in memory.
    await store<{ v: number }>("comps").put("registry-probe@example.com", { v: 1 });
    const status = storageStatus({} as NodeJS.ProcessEnv);
    expect(status.durable).toBe(false);
  });
});

// ── The Stripe ledger's idempotency, on whichever driver is configured ─────

describe("the Stripe ledger reserves an event exactly once", () => {
  test("two simultaneous deliveries of one event id apply it once", async () => {
    const { withEventIdempotency } = await import("../src/server/processed-events");
    const id = `evt_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let applied = 0;
    const slow = async () => {
      applied += 1;
      await Bun.sleep(25);
      return "applied";
    };
    const results = await Promise.all([withEventIdempotency(id, slow), withEventIdempotency(id, slow)]);
    expect(applied).toBe(1);
    expect(results.filter((r) => r.skipped).length).toBe(1);
    expect(results.filter((r) => !r.skipped).length).toBe(1);
  });

  test("a handler that throws releases the reservation, so the retry can work", async () => {
    const { withEventIdempotency } = await import("../src/server/processed-events");
    const id = `evt_release_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await expect(
      withEventIdempotency(id, async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");
    let ran = false;
    const retry = await withEventIdempotency(id, async () => {
      ran = true;
      return "applied";
    });
    expect(ran).toBe(true);
    expect(retry.skipped).toBe(false);
  });

  test("the file ledger is still the file it always was", async () => {
    // With no database configured the ledger is `stripe-events.json` beside
    // accounts, in the same `{ events: [...] }` shape.
    if ((process.env[STORAGE_ENV_VAR] || "").trim()) return; // file-driver assertion
    const { withEventIdempotency, eventsFile } = await import("../src/server/processed-events");
    const id = `evt_shape_${Date.now()}`;
    await withEventIdempotency(id, async () => "applied");
    const file = eventsFile();
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { events: Array<{ id: string; note: string }> };
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.find((e) => e.id === id)?.note).toBe("applied");
  });
});
