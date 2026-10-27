/**
 * Pre-flight for the auth surface — run this before and after a deploy.
 *
 *   bun scripts/verify-auth-surface.ts [baseUrl]
 *
 * Defaults to the platform host. Reads OWNER_PASSWORD from the environment when
 * it exists, so the owner-seat checks light up the moment that secret is saved.
 * Creates ONE throwaway account per run (email is timestamped) — harmless, but
 * expect it to appear in the user table.
 *
 * Checks the contract, not the pixels:
 *   1. no token            -> 401
 *   2. forged token        -> 401   (this is the localforage forgery that used to work)
 *   3. genuine signup      -> 200 with a 64-hex server token
 *   4. that token          -> 200 and subscription:false (a non-paying account)
 *   5. owner + wrong pw    -> 401  (even when OWNER_PASSWORD is set)
 *   6. owner + secret      -> 200, plan pro   (skipped if OWNER_PASSWORD unset)
 *   7. webhook endpoint    -> never 200 without a valid signature
 */
// The apex everyonesawinner.uk 308-redirects to www, and a redirect across
// origins drops the Authorization header — so a check run straight at the apex
// reports a bogus 401. Always measure the canonical host.
const canonical = (u: string): string =>
  u.replace(/^https?:\/\/everyonesawinner\.uk/i, "https://www.everyonesawinner.uk").replace(/\/$/, "");
const base = canonical(process.argv[2] || "https://515136800b641762e9aace79427eb7c4.ctonew.app");
const ownerPw = process.env.OWNER_PASSWORD || "";
const ownerEmail = (process.env.OWNER_EMAILS || "owner@everyonesawinner.uk").split(",")[0].trim();

const results: boolean[] = [];
function check(pass: boolean, label: string, detail = ""): void {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function get(path: string, token?: string): Promise<Response> {
  return fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
}

async function main(): Promise<void> {
  // 1 + 2 — the session must be decided by the server.
  const noToken = await get("/api/me");
  check(noToken.status === 401, "no token rejected by /api/me", `http ${noToken.status}`);

  const forged = await get("/api/me", "deadbeef");
  check(forged.status === 401, "forged token rejected by /api/me", `http ${forged.status}`);

  // 3 + 4 — a real account, with the plan the server believes.
  const email = `verify-${Date.now()}@example.com`;
  const signup = await fetch(base + "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Surface Check", email, password: "password-123" }),
  });
  const signupBody = (await signup.json().catch(() => ({}))) as { user?: { token?: string } };
  const token = signupBody?.user?.token || "";
  check(signup.status === 200 && /^[0-9a-f]{64}$/.test(token), "genuine signup returns a real session token", `http ${signup.status}`);

  if (token) {
    const me = await get("/api/me", token);
    const body = (await me.json().catch(() => ({}))) as { user?: { subscription?: boolean; plan?: string | null } };
    check(
      me.status === 200 && body?.user?.subscription === false && (body?.user?.plan ?? null) === null,
      "genuine non-paying account is reported as non-paying",
      `http ${me.status}`,
    );
  } else {
    check(false, "genuine non-paying account is reported as non-paying", "no token to check");
  }

  // 5 + 6 — the owner seat.
  const wrong = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "definitely-not-the-secret-9" }),
  });
  check(wrong.status === 401, "owner email + wrong password rejected", `http ${wrong.status}`);

  if (ownerPw) {
    const ok = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: ownerPw }),
    });
    const body = (await ok.json().catch(() => ({}))) as { user?: { plan?: string | null; subscription?: boolean } };
    check(
      ok.status === 200 && body?.user?.plan === "pro" && body?.user?.subscription === true,
      "owner logs in with OWNER_PASSWORD and gets pro",
      `http ${ok.status}`,
    );
  } else {
    console.log("SKIP  owner login with OWNER_PASSWORD — secret not set in this environment");
  }

  // 7 — the webhook must never grant anything unsigned.
  const hook = await fetch(base + "/api/stripe-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
  });
  check(hook.status !== 200, "unsigned webhook does not grant access", `http ${hook.status}`);

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed === 0 ? "All auth-surface checks passed." : `${failed} check(s) FAILED.`}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
