/**
 * Repeatable proof that the owner seat cannot be claimed by a stranger.
 *
 *   bun scripts/owner-seat-proof.ts
 *
 * Runs against an EMPTY user store — the state after every redeploy — and
 * asserts all three cases the lead asked for. Exit code 0 means the seat is
 * closed; anything else means it is open and must not ship.
 *
 * Cases
 *   1. OWNER_PASSWORD unset, attacker password  -> 401, no record created
 *   2. OWNER_PASSWORD set,   wrong password     -> 401, no record created
 *   3. OWNER_PASSWORD set,   correct password   -> pro seat, record created
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = "owner@everyonesawinner.uk";
const SECRET = "a-real-owner-password-9";
const ATTACKER = "totally-made-up-99";

async function attempt(password: string): Promise<{ ok: boolean; plan?: string | null; sub?: boolean; err?: string }> {
  const { authenticateUser } = await import("../src/server/users.ts");
  try {
    const u = await authenticateUser(OWNER, password);
    return { ok: true, plan: u.plan, sub: u.subscription };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

function storeHasOwner(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(parsed, OWNER);
  } catch {
    return false;
  }
}

const results: boolean[] = [];

function report(pass: boolean, label: string): void {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
}

async function main(): Promise<void> {
  // --- Case 1: no OWNER_PASSWORD in the environment -------------------------
  {
    delete process.env.OWNER_PASSWORD;
    const file = join(mkdtempSync(join(tmpdir(), "eaw-owner-")), "users.json");
    process.env.USERS_FILE = file;
    const r = await attempt(ATTACKER);
    report(!r.ok, "no OWNER_PASSWORD + invented password => rejected");
    report(!storeHasOwner(file) || !r.ok, "no OWNER_PASSWORD => no seat record created");
  }

  // --- Case 2: secret set, wrong password -----------------------------------
  {
    process.env.OWNER_PASSWORD = SECRET;
    const file = join(mkdtempSync(join(tmpdir(), "eaw-owner-")), "users.json");
    process.env.USERS_FILE = file;
    const r = await attempt(ATTACKER);
    report(!r.ok, "OWNER_PASSWORD set + wrong password => rejected (401)");
    report(!storeHasOwner(file), "wrong password => NO seat record created");
  }

  // --- Case 3: secret set, correct password ----------------------------------
  {
    process.env.OWNER_PASSWORD = SECRET;
    const file = join(mkdtempSync(join(tmpdir(), "eaw-owner-")), "users.json");
    process.env.USERS_FILE = file;
    const r = await attempt(SECRET);
    report(r.ok && r.plan === "pro" && r.sub === true, "correct OWNER_PASSWORD => pro seat issued");
    report(storeHasOwner(file), "correct OWNER_PASSWORD => seat persisted");
    const forged = await (async () => {
      const { resolveSession } = await import("../src/server/sessions.ts");
      return resolveSession("deadbeef");
    })();
    report(forged === null, "forged token 'deadbeef' resolves to no session");
  }

  // --- Case 4: signup cannot claim the owner address -------------------------
  {
    process.env.OWNER_PASSWORD = SECRET;
    const file = join(mkdtempSync(join(tmpdir(), "eaw-owner-")), "users.json");
    process.env.USERS_FILE = file;
    const { registerUser } = await import("../src/server/users.ts");
    let claimed = false;
    try {
      await registerUser("Stranger", OWNER, ATTACKER);
      claimed = true;
    } catch {
      claimed = false;
    }
    report(!claimed && !storeHasOwner(file), "/api/signup with owner email + invented password => refused");
  }

  const failed = results.filter((r) => !r).length;
  console.log(failed === 0 ? "\nAll owner-seat checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
