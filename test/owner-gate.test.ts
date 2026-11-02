import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireOwnerSession } from "../src/server/pro-gate";
import { issueSession } from "../src/server/sessions";
import { registerUser, setPlan } from "../src/server/users";

/**
 * THE OWNER GATE — `/api/feed-diagnostics` and `/api/alert-status` are the
 * owner's operations information, not a customer feature.
 *
 * WHAT THESE TESTS PIN (owner instruction, 2026-11-02): a stranger, and even a
 * paying subscriber, must get the same 404 a non-existent route gives. Only the
 * identity the owner logs in with gets through. Every refusal is a 404 — never a
 * 401 or 403 — so the endpoint cannot be discovered by its error.
 *
 * A refusal that is a 500, or a gate that falls open when OWNER_PASSWORD is
 * unset, would be the whole leak again.
 */

const OWNER_EMAIL = "owner@everyonesawinner.uk"; // DEFAULT_OWNER_EMAILS
const CUSTOMER_EMAIL = "punter@example.com";
const OWNER_SECRET = "owner-secret-for-this-test";
const PASSWORD = "CorrectHorse9!";

let dir: string;
let ownerToken: string;
let customerToken: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eaw-owner-gate-"));
  for (const key of ["USERS_FILE", "SESSIONS_FILE", "OWNER_PASSWORD", "DATABASE_URL"]) {
    saved[key] = process.env[key];
  }
  // The JSON stores, in a temp dir: this test must never touch the real ones.
  process.env.USERS_FILE = join(dir, "users.json");
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OWNER_PASSWORD = OWNER_SECRET;
  delete process.env.DATABASE_URL;

  // The owner seat, and a customer who is on the top paid plan.
  // The owner seat can only be created with the owner secret itself (users.ts).
  await registerUser("Owner", OWNER_EMAIL, OWNER_SECRET);
  ownerToken = await issueSession(OWNER_EMAIL);
  await registerUser("Punter", CUSTOMER_EMAIL, PASSWORD);
  await setPlan(CUSTOMER_EMAIL, "pro");
  customerToken = await issueSession(CUSTOMER_EMAIL);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/feed-diagnostics", { headers });
}

describe("owner gate — 404 for everyone but the owner", () => {
  test("anonymous (no token at all) is a 404 that says nothing", async () => {
    const gate = await requireOwnerSession(req());
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.status).toBe(404);
      expect(gate.error).toBe("not_found");
      // It must not confirm that the endpoint exists.
      expect(gate.message).toBe("Not found.");
    }
  });

  test("a made-up bearer token is the same 404", async () => {
    const gate = await requireOwnerSession(req({ authorization: `Bearer ${"a".repeat(64)}` }));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.status).toBe(404);
  });

  test("a PAYING non-owner is a 404 — a subscription is not ownership", async () => {
    const gate = await requireOwnerSession(req({ authorization: `Bearer ${customerToken}` }));
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.status).toBe(404);
      expect(gate.error).toBe("not_found");
      expect(gate.message).toBe("Not found.");
    }
  });

  test("the owner gets through, and is told which account it was", async () => {
    const gate = await requireOwnerSession(req({ authorization: `Bearer ${ownerToken}` }));
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.email).toBe(OWNER_EMAIL);
  });

  test("with OWNER_PASSWORD unset the seat fails CLOSED, even for the owner", async () => {
    const secret = process.env.OWNER_PASSWORD;
    delete process.env.OWNER_PASSWORD;
    try {
      const gate = await requireOwnerSession(req({ authorization: `Bearer ${ownerToken}` }));
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.status).toBe(404);
    } finally {
      process.env.OWNER_PASSWORD = secret;
    }
  });
});
