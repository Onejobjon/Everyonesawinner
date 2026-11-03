import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compGrants, isEntitled, isProEntitled } from "../src/server/entitlement";
import { listComps, parseGrantInput, putComp, readComp } from "../src/server/comps";
import { handleCompsApi } from "../src/server/comps-api";
import { requireProSession } from "../src/server/pro-gate";
import { issueSession } from "../src/server/sessions";
import { findByEmail, registerUser, setComp } from "../src/server/users";

/**
 * FREE-ACCESS GRANTS — the owner can give a named person free use of the site.
 *
 * WHAT THESE TESTS PIN (owner request, 2026-11-02: "How can I give someone free
 * use of the site?"):
 *   • a comped account is IN, on the plan it was given (Pro unlocks Pro tools);
 *   • an EXPIRED comp is OUT — access stops by itself, no one has to remember;
 *   • a REVOKED comp is OUT — clearing it is immediate;
 *   • a grant given BEFORE the person signed up applies when they register;
 *   • nobody but the owner can grant or revoke — they get the same bare 404;
 *   • an UNDATED comp that was not explicitly made permanent grants NOTHING.
 *
 * The last one is the rule that must not weaken: "no end date" is a decision
 * somebody made (`permanent: true`), never a field somebody forgot.
 */

const OWNER_EMAIL = "owner@everyonesawinner.uk";
const OWNER_SECRET = "owner-secret-for-this-test";
const PASSWORD = "CorrectHorse9!";

let dir: string;
let ownerToken: string;
const saved: Record<string, string | undefined> = {};

const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function apiReq(path: string, opts: { token?: string; method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`https://example.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function callApi(
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await handleCompsApi(apiReq(path, opts), new URL(`https://example.test${path}`));
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eaw-free-access-"));
  for (const key of ["USERS_FILE", "SESSIONS_FILE", "COMPS_FILE", "OWNER_PASSWORD", "DATABASE_URL"]) {
    saved[key] = process.env[key];
  }
  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.COMPS_FILE = join(dir, "comps.json");
  process.env.OWNER_PASSWORD = OWNER_SECRET;
  delete process.env.DATABASE_URL;

  await registerUser("Owner", OWNER_EMAIL, OWNER_SECRET);
  ownerToken = await issueSession(OWNER_EMAIL);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the rule — a comp is dated, explicit and revocable", () => {
  test("a dated comp in the future grants access; the same comp in the past does not", () => {
    const future = { plan: "pro" as const, endsAt: iso(5 * DAY) };
    const past = { plan: "pro" as const, endsAt: iso(-1 * DAY) };
    expect(compGrants(future)).toBe(true);
    expect(compGrants(past)).toBe(false);
    expect(isEntitled({ plan: "pro", status: "comp", currentPeriodEnd: future.endsAt, graceEndsAt: null, comp: future })).toBe(true);
    expect(isEntitled({ plan: "pro", status: "comp", currentPeriodEnd: past.endsAt, graceEndsAt: null, comp: past })).toBe(false);
  });

  test("an UNDATED comp grants nothing unless it is explicitly permanent", () => {
    expect(compGrants({ plan: "pro", endsAt: null })).toBe(false);
    expect(compGrants({ plan: "pro", endsAt: null, permanent: true })).toBe(true);
    // …and an unknown plan still grants nothing, permanent or not.
    expect(compGrants({ plan: "vip" as never, endsAt: null, permanent: true })).toBe(false);
  });

  test("a comped Pro unlocks the Pro-only tools", () => {
    const comp = { plan: "pro" as const, endsAt: iso(10 * DAY) };
    expect(isProEntitled({ plan: "pro", status: "comp", currentPeriodEnd: comp.endsAt, graceEndsAt: null, comp })).toBe(true);
  });
});

describe("comped in / expired out / revoked out", () => {
  test("a comped account is signed in, entitled and on Pro", async () => {
    const email = "friend@example.com";
    await registerUser("Friend", email, PASSWORD);
    const granted = await callApi("/api/comps", {
      token: ownerToken,
      method: "POST",
      body: { email, plan: "pro", days: 30, note: "new to match betting" },
    });
    expect(granted.status).toBe(200);
    expect(granted.body.ok).toBe(true);
    expect(granted.body.appliedToAccount).toBe(true);

    const user = await findByEmail(email);
    expect(user?.entitled).toBe(true);
    expect(user?.plan).toBe("pro");
    expect(user?.comp?.note).toBe("new to match betting");

    // The server-side gate on the credit-spending endpoints agrees.
    const token = await issueSession(email);
    const gate = await requireProSession(apiReq("/api/same-match", { token }), "this search");
    expect(gate.ok).toBe(true);
  });

  test("an expired comp is OUT", async () => {
    const email = "expired@example.com";
    await registerUser("Expired", email, PASSWORD);
    await callApi("/api/comps", {
      token: ownerToken,
      method: "POST",
      body: { email, plan: "pro", days: 30 },
    });
    // Move the clock: the grant ended yesterday, in the owner's list and on the
    // account alike (that is what "time passed" does to both).
    const granted = readComp(email)!;
    const expired = { ...granted, endsAt: iso(-1 * DAY) };
    putComp(expired);
    await setComp(email, expired);

    const user = await findByEmail(email);
    expect(user?.entitled).toBe(false);
    const token = await issueSession(email);
    const gate = await requireProSession(apiReq("/api/same-match", { token }), "this search");
    expect(gate.ok).toBe(false);
  });

  test("a revoked comp is OUT immediately, and leaves the list", async () => {
    const email = "revoked@example.com";
    await registerUser("Revoked", email, PASSWORD);
    await callApi("/api/comps", {
      token: ownerToken,
      method: "POST",
      body: { email, plan: "pro", days: 30 },
    });
    expect((await findByEmail(email))?.entitled).toBe(true);

    const revoked = await callApi("/api/comps/revoke", {
      token: ownerToken,
      method: "POST",
      body: { email },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.ok).toBe(true);

    expect((await findByEmail(email))?.entitled).toBe(false);
    expect(readComp(email)).toBeNull();
    expect(listComps().some((g) => g.email === email)).toBe(false);
  });

  test("a grant given BEFORE signup applies at registration", async () => {
    const email = "not-signed-up-yet@example.com";
    const granted = await callApi("/api/comps", {
      token: ownerToken,
      method: "POST",
      body: { email, plan: "pro", days: 14 },
    });
    expect(granted.status).toBe(200);
    // No account yet: the grant waits in the owner's list.
    expect(granted.body.appliedToAccount).toBe(false);
    expect(readComp(email)?.plan).toBe("pro");

    const created = await registerUser("Newcomer", email, PASSWORD);
    expect(created.entitled).toBe(true);
    expect(created.plan).toBe("pro");
    expect((await findByEmail(email))?.entitled).toBe(true);
  });
});

describe("owner only — everyone else gets a bare 404", () => {
  test("anonymous callers cannot read or create grants", async () => {
    const read = await callApi("/api/comps");
    expect(read.status).toBe(404);
    expect(read.body.error).toBe("not_found");
    expect(read.body.message).toBe("Not found.");

    const write = await callApi("/api/comps", {
      method: "POST",
      body: { email: "stranger@example.com", plan: "pro", days: 30 },
    });
    expect(write.status).toBe(404);
    expect(readComp("stranger@example.com")).toBeNull();
  });

  test("a signed-in CUSTOMER cannot grant or revoke", async () => {
    const email = "customer@example.com";
    await registerUser("Customer", email, PASSWORD);
    const token = await issueSession(email);

    const grant = await callApi("/api/comps", {
      token,
      method: "POST",
      body: { email: "friend2@example.com", plan: "pro", days: 30 },
    });
    expect(grant.status).toBe(404);
    expect(readComp("friend2@example.com")).toBeNull();

    const revoke = await callApi("/api/comps/revoke", {
      token,
      method: "POST",
      body: { email: "friend@example.com" },
    });
    expect(revoke.status).toBe(404);
  });

  test("with OWNER_PASSWORD unset the panel fails closed, even for the owner", async () => {
    const secret = process.env.OWNER_PASSWORD;
    delete process.env.OWNER_PASSWORD;
    try {
      const list = await callApi("/api/comps", { token: ownerToken });
      expect(list.status).toBe(404);
    } finally {
      process.env.OWNER_PASSWORD = secret;
    }
  });

  test("the owner sees the list", async () => {
    const list = await callApi("/api/comps", { token: ownerToken });
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(Array.isArray(list.body.grants)).toBe(true);
    const friend = list.body.grants.find((g: { email: string }) => g.email === "friend@example.com");
    expect(friend?.live).toBe(true);
  });
});

describe("what the owner types is checked before it grants anything", () => {
  test("an email is required and a plan must be one we sell", () => {
    expect(parseGrantInput({ email: "", plan: "pro" }, OWNER_EMAIL).ok).toBe(false);
    expect(parseGrantInput({ email: "not-an-email", plan: "pro" }, OWNER_EMAIL).ok).toBe(false);
    expect(parseGrantInput({ email: "a@b.co", plan: "platinum" }, OWNER_EMAIL).ok).toBe(false);
  });

  test("days default to 30 and an undated grant must be asked for", () => {
    const parsed = parseGrantInput({ email: "a@b.co", plan: "pro" }, OWNER_EMAIL);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const days = (Date.parse(parsed.grant.endsAt!) - Date.now()) / DAY;
      expect(Math.round(days)).toBe(30);
      expect(parsed.grant.permanent).toBe(false);
      expect(parsed.grant.grantedBy).toBe(OWNER_EMAIL);
    }
    const forever = parseGrantInput({ email: "a@b.co", plan: "pro", permanent: true }, OWNER_EMAIL);
    expect(forever.ok).toBe(true);
    if (forever.ok) {
      expect(forever.grant.endsAt).toBeNull();
      expect(forever.grant.permanent).toBe(true);
    }
  });
});
