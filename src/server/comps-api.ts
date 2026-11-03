/**
 * OWNER-ONLY free-access grant endpoints.
 *
 *   GET  /api/comps          — the owner's list of grants (live and expired)
 *   POST /api/comps          — grant: { email, plan, days?, note?, permanent? }
 *   POST /api/comps/revoke   — revoke: { email }
 *
 * Every one of them sits behind requireOwnerSession(), the SAME seat check that
 * guards /api/alert-status and /api/feed-diagnostics. A stranger, a signed-in
 * customer and a paying subscriber all get the identical bare 404, so the
 * endpoint cannot even be discovered — and with OWNER_PASSWORD unset the seat
 * fails closed, exactly as it does elsewhere.
 *
 * Nothing here can hand out access by accident: the grant is validated by
 * parseGrantInput() (a real email, a plan we sell, days defaulting to 30, and an
 * undated grant only when the owner ticked "no end date"), and entitlement is
 * still decided by compGrants() in src/server/entitlement.ts.
 */
import { compGrants } from "./entitlement";
import { compOf, listComps, parseGrantInput, putComp, removeComp } from "./comps";
import { setComp } from "./users";
import { requireOwnerSession } from "./pro-gate";

const NO_STORE = { "cache-control": "no-store" };

/** The same silent 404 the owner gate gives — never confirms the route exists. */
function notFound(): Response {
  return Response.json({ error: "not_found", message: "Not found." }, { status: 404, headers: NO_STORE });
}

function badRequest(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400, headers: NO_STORE });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function handleCompsApi(req: Request, url: URL): Promise<Response> {
  const gate = await requireOwnerSession(req);
  if (!gate.ok) return notFound();

  // THE LIST — what the owner sees in the panel. `live` is the server's answer
  // to "does this grant access right now", so the panel never has to guess.
  if (url.pathname === "/api/comps" && req.method === "GET") {
    const now = Date.now();
    const grants = listComps().map((g) => ({ ...g, live: compGrants(g, now) }));
    return Response.json({ ok: true, grants }, { headers: NO_STORE });
  }

  // GRANT — works whether or not the address has an account yet. The ledger
  // entry is the owner's list; the account record (when there is one) is what
  // entitlement reads. A grant for an address that has not signed up is applied
  // at registration (src/server/users.ts).
  if (url.pathname === "/api/comps" && req.method === "POST") {
    const parsed = parseGrantInput(await readJson(req), gate.email);
    if (!parsed.ok) return badRequest(parsed.error);
    putComp(parsed.grant);
    let appliedToAccount = false;
    try {
      appliedToAccount = await setComp(parsed.grant.email, compOf(parsed.grant));
    } catch (e) {
      // The list still holds the grant and the next account lookup applies it;
      // say so in the log rather than pretend the write succeeded.
      console.error(`[comps] grant stored in the ledger but not on the account: ${String(e)}`);
    }
    return Response.json(
      { ok: true, grant: { ...parsed.grant, live: true }, appliedToAccount },
      { headers: NO_STORE },
    );
  }

  // REVOKE — clears both the list and the account, so the next request from
  // that person is refused. Revoking an address with no grant is not an error.
  if (url.pathname === "/api/comps/revoke" && req.method === "POST") {
    const body = (await readJson(req)) as { email?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return badRequest("Which email address should lose its free access?");
    const hadLedgerEntry = removeComp(email);
    let clearedAccount = false;
    try {
      clearedAccount = await setComp(email, null);
    } catch (e) {
      console.error(`[comps] revoke cleared the ledger but not the account: ${String(e)}`);
    }
    return Response.json(
      { ok: true, email, hadLedgerEntry, clearedAccount },
      { headers: NO_STORE },
    );
  }

  // Anything else under this prefix, from the owner: the route does not exist.
  if (url.pathname.startsWith("/api/comps")) {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405, headers: NO_STORE });
  }
  return notFound();
}
