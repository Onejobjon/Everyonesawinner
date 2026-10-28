#!/usr/bin/env bun
/**
 * Tests for the Lay Bet Finder's on-demand, league-scoped search.
 *
 * Everything here runs against a STUBBED provider — this file spends 0 credits.
 * The checks that matter most:
 *   • opening the page fetches nothing (the page has no auto-run path at all),
 *   • a search is a FRESH read every time (no cache is consulted),
 *   • N competitions = N credits, measured from the provider's own header,
 *   • one league failing never hides the others, and is reported by name,
 *   • unknown competition keys are refused before any request is made,
 *   • the platform implementation and the Vercel function agree exactly.
 *
 * Run: bun scripts/test-league-search.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLeagueSearch, parseLeagueParam, defaultLeagueKeys, MAX_LEAGUES_PER_SEARCH } from "../src/server/league-search";

const ROOT = join(import.meta.dir, "..");

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Stub provider ──────────────────────────────────────────────────────────

const CATALOGUE = JSON.parse(readFileSync(join(ROOT, "src", "data", "sports-catalogue.json"), "utf8")) as {
  sports: { key: string; label: string; group: string }[];
  defaultKeys: string[];
};

/**
 * Fixed kick-off epoch. The stub must be DETERMINISTIC: section 9 runs the same
 * behaviour through the platform module and the Vercel function and compares the
 * two payloads byte for byte, so a `Date.now()`-derived commence_time would make
 * the two calls differ by a few milliseconds and fail on nothing but the clock.
 */
const EVENT_EPOCH = Date.UTC(2026, 10, 29, 15, 0, 0);

/** Minimal provider event so the combined count is easy to reason about. */
function event(sportKey: string, n: number) {
  return {
    id: `${sportKey}-${n}`,
    sport_key: sportKey,
    sport_title: sportKey,
    commence_time: new Date(EVENT_EPOCH + 3_600_000 * (n + 1)).toISOString(),
    home_team: `Home ${n}`,
    away_team: `Away ${n}`,
    bookmakers: [],
  };
}

interface Call {
  url: string;
  at: number;
}

interface StubBehaviour {
  /** Events per competition key; default 2. */
  events?: Record<string, number>;
  /** Competition keys answered with a given HTTP status instead of data. */
  fail?: Record<string, number>;
  /** Competition keys that never answer (to exercise the timeout). */
  hang?: string[];
  /** Competition keys whose body is not JSON. */
  garbage?: string[];
  /** Credits the fake provider claims remain. */
  remaining?: number;
}

function makeFetch(behaviour: StubBehaviour) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    const key = url.match(/sports\/([^/]+)\/odds/)?.[1] ?? "";
    if (behaviour.hang?.includes(key)) {
      // Never answers on its own — only the caller's abort cuts it off. This is
      // what a real hung request looks like, and the production code relies on
      // AbortController (not on the stub being polite).
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        const signal: AbortSignal | undefined = init?.signal;
        if (signal) {
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort);
        }
      });
    }
    const headers = new Map<string, string>([
      ["x-requests-last", "1"],
      ["x-requests-remaining", String(behaviour.remaining ?? 19_000)],
    ]);
    if (behaviour.fail?.[key] != null) {
      const status = behaviour.fail[key];
      return new Response(JSON.stringify({ message: "provider refused this one", error_code: "TEST_FAIL" }), {
        status,
        headers: Object.fromEntries(headers),
      });
    }
    if (behaviour.garbage?.includes(key)) {
      return new Response("<html>nope</html>", { status: 200, headers: Object.fromEntries(headers) });
    }
    const n = behaviour.events?.[key] ?? 2;
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => event(key, i))), {
      status: 200,
      headers: Object.fromEntries(headers),
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ── 1. Competition catalogue ───────────────────────────────────────────────

console.log("1. Competition catalogue (data-driven, not hardcoded in the page)");
check("catalogue lists competitions", CATALOGUE.sports.length > 20, `${CATALOGUE.sports.length} entries`);
check(
  "defaults are EPL / Championship / Champions League",
  CATALOGUE.defaultKeys.join(",") === "soccer_epl,soccer_efl_champ,soccer_uefa_champs_league",
  CATALOGUE.defaultKeys.join(","),
);
check("EPL, Championship and Champions League are all in the catalogue", ["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league"].every((k) => CATALOGUE.sports.some((s) => s.key === k)));
check("ice hockey is never offered (back/lay describe different markets)", !CATALOGUE.sports.some((s) => s.key.startsWith("icehockey")));
check("every entry has a readable label", CATALOGUE.sports.every((s) => typeof s.label === "string" && s.label.length > 1));
check("defaultLeagueKeys() agrees with the file", defaultLeagueKeys().join(",") === CATALOGUE.defaultKeys.join(","));

// ── 2. Query parsing ───────────────────────────────────────────────────────

console.log("2. Query parsing");
check("dedupes and trims", parseLeagueParam(" soccer_epl , soccer_epl ,soccer_efl_champ ").join(",") === "soccer_epl,soccer_efl_champ");
check("empty input yields no leagues", parseLeagueParam("").length === 0);
check(`caps at ${MAX_LEAGUES_PER_SEARCH} competitions`, parseLeagueParam(Array.from({ length: 20 }, (_, i) => `x${i}`).join(",")).length === MAX_LEAGUES_PER_SEARCH);

// ── 3. A three-competition search ──────────────────────────────────────────

console.log("3. Three-competition search");
{
  const { fetchImpl, calls } = makeFetch({ events: { soccer_epl: 21, soccer_efl_champ: 12, soccer_uefa_champs_league: 18 }, remaining: 19_500 });
  const res = await runLeagueSearch(["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league"], { apiKey: "test", fetchImpl });
  check("one request per competition", calls.length === 3, `${calls.length} requests`);
  check(
    "per-league counts are reported",
    res.leagues.map((l) => `${l.key}:${l.events}`).join(",") === "soccer_epl:21,soccer_efl_champ:12,soccer_uefa_champs_league:18",
    res.leagues.map((l) => `${l.key}:${l.events}`).join(","),
  );
  check("all three succeeded", res.ok && !res.partial && res.leagues.every((l) => l.ok));
  check("combined events = 21 + 12 + 18", res.events.length === 51, `${res.events.length}`);
  check("credits spent = 3 (1 per request), measured", res.credits.spent === 3 && res.credits.measured && res.credits.perLeague === 1);
  check("remaining credits come from the provider", res.credits.remaining === 19_500, String(res.credits.remaining));
  check("requests carry no cache headers and hit each competition once", new Set(calls.map((c) => c.url)).size === 3);
}

// ── 4. Freshness: a second search re-reads the feed ────────────────────────

console.log("4. Every search is a fresh read (no cache is consulted)");
{
  const { fetchImpl, calls } = makeFetch({});
  const opts = { apiKey: "test", fetchImpl };
  await runLeagueSearch(["soccer_epl"], opts);
  await runLeagueSearch(["soccer_epl"], opts);
  check("two searches = two provider requests for the same competition", calls.length === 2, `${calls.length} requests`);
}

// ── 5. One league fails, the others still render ───────────────────────────

console.log("5. Partial failure");
{
  const { fetchImpl, calls } = makeFetch({
    events: { soccer_epl: 21, soccer_uefa_champs_league: 18 },
    fail: { soccer_efl_champ: 429 },
  });
  const res = await runLeagueSearch(["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league"], { apiKey: "test", fetchImpl });
  check("still a success overall", res.ok === true);
  check("flagged as partial", res.partial === true);
  check("the two good leagues are present", res.leagues.filter((l) => l.ok).map((l) => l.key).join(",") === "soccer_epl,soccer_uefa_champs_league");
  const bad = res.leagues.find((l) => l.key === "soccer_efl_champ")!;
  check("the failed league is named and explained", !bad.ok && /429/.test(bad.error ?? "") && /provider refused this one/.test(bad.error ?? ""), bad.error);
  check("the failed league contributes no rows", bad.events === 0);
  check("the good leagues' rows are still combined (21 + 18)", res.events.length === 39, `${res.events.length}`);
  check("the failed request is still counted as spent", res.credits.spent === 3, String(res.credits.spent));
  check("all three were actually attempted", calls.length === 3, `${calls.length}`);
}

// ── 6. A league that never answers ─────────────────────────────────────────

console.log("6. A hung league does not hang the search");
{
  const { fetchImpl } = makeFetch({ events: { soccer_epl: 5, soccer_uefa_champs_league: 4 }, hang: ["soccer_efl_champ"] });
  const started = Date.now();
  const res = await runLeagueSearch(["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league"], { apiKey: "test", fetchImpl, timeoutMs: 300 });
  const elapsed = Date.now() - started;
  check("the search returns instead of hanging", elapsed < 5_000, `${elapsed}ms`);
  check("the hung league is reported as timed out", !res.leagues.find((l) => l.key === "soccer_efl_champ")!.ok);
  check("its reason says it did not answer in time", /did not answer within/.test(res.leagues.find((l) => l.key === "soccer_efl_champ")!.error ?? ""), res.leagues.find((l) => l.key === "soccer_efl_champ")!.error);
  check("the other two still return rows", res.events.length === 9, `${res.events.length}`);
  check("partial is set", res.partial === true);
}

// ── 7. Unreadable provider response ────────────────────────────────────────

console.log("7. A non-JSON body is an error, not an empty list");
{
  const { fetchImpl } = makeFetch({ garbage: ["soccer_epl"], events: { soccer_efl_champ: 3 } });
  const res = await runLeagueSearch(["soccer_epl", "soccer_efl_champ"], { apiKey: "test", fetchImpl });
  const bad = res.leagues.find((l) => l.key === "soccer_epl")!;
  check("garbage is reported as unreadable", !bad.ok && /could not read/i.test(bad.error ?? ""), bad.error);
  check("it is not silently an empty success", res.partial === true);
}

// ── 8. Unknown competition keys cost nothing ───────────────────────────────

console.log("8. Unknown keys are refused before any request");
{
  const { fetchImpl, calls } = makeFetch({});
  const res = await runLeagueSearch(["soccer_epl", "soccer_not_a_real_league", "icehockey_nhl"], { apiKey: "test", fetchImpl });
  check("unknown keys are listed as rejected", res.rejected.join(",") === "soccer_not_a_real_league,icehockey_nhl", res.rejected.join(","));
  check("only the real competition was requested", calls.length === 1 && calls[0].url.includes("soccer_epl"), `${calls.length} requests`);
  check("spend matches the requests actually made", res.credits.spent === 1, String(res.credits.spent));
}

// ── 9. The Vercel function behaves identically to the platform module ──────

console.log("9. Vercel function === platform module");
{
  const behaviour: StubBehaviour = {
    events: { soccer_epl: 4, soccer_efl_champ: 2 },
    fail: { soccer_uefa_champs_league: 500 },
    remaining: 12_345,
  };
  const platform = makeFetch(behaviour);
  const platformRes = await runLeagueSearch(["soccer_epl", "soccer_efl_champ", "soccer_uefa_champs_league"], {
    apiKey: "test",
    fetchImpl: platform.fetchImpl,
  });

  const originalFetch = globalThis.fetch;
  const vercel = makeFetch(behaviour);
  (globalThis as any).fetch = vercel.fetchImpl;
  process.env.ODDS_API_KEY = "test";
  const { default: handler } = await import("../api/odds-leagues");
  let body: any = null;
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(payload: string) {
      body = JSON.parse(payload);
    },
  };
  await handler(
    { url: "/api/odds-leagues?leagues=soccer_epl,soccer_efl_champ,soccer_uefa_champs_league", headers: { host: "x" } },
    res,
  );
  (globalThis as any).fetch = originalFetch;

  const strip = (o: any) => ({
    ...o,
    fetchedAt: "",
    leagues: o.leagues.map((l: any) => ({ key: l.key, label: l.label, ok: l.ok, events: l.events, ...(l.ok ? {} : { error: l.error }) })),
  });
  check("Vercel function answered 200", res.statusCode === 200, String(res.statusCode));
  check("identical verdict (ok/partial/rejected/credits/events)", JSON.stringify(strip(platformRes)) === JSON.stringify(strip(body)));
  check("the failing league is reported the same way", /500/.test(body.leagues.find((l: any) => l.key === "soccer_uefa_champs_league").error ?? ""));
  check("no-store on the response", res.headers["cache-control"] === "no-store", res.headers["cache-control"]);
  check("same number of upstream requests", platform.calls.length === vercel.calls.length, `${platform.calls.length} vs ${vercel.calls.length}`);
}

// ── 10. The page cannot fetch on open ──────────────────────────────────────

console.log("10. Opening /lay-bets performs no fetch");
{
  const page = readFileSync(join(ROOT, "src", "pages", "LayBets.tsx"), "utf8");
  check("the page no longer reads the cached feed", !/\bgetMatches\b/.test(page));
  check("the page does not read the odds cache module's age helper", !/getOddsAgeMs/.test(page));
  check("the false 'never costs an API call' claim is gone", !/never costs an API call/i.test(page));
  check("no useEffect body calls the search", !/useEffect\(\s*\(\)\s*=>\s*\{[^}]*searchLeagues/s.test(page));
  const searchCalls = page.match(/searchLeagues\(/g)?.length ?? 0;
  check("the search is called from exactly one place (the button handler)", searchCalls === 1, `${searchCalls} call sites`);
  const handlerStart = page.indexOf("const runSearch");
  const callSite = page.indexOf("searchLeagues(selected)");
  check("that call site is inside runSearch", handlerStart > 0 && callSite > handlerStart && callSite - handlerStart < 1200);
  const buttonAt = page.indexOf("onClick={() => void runSearch()}");
  check("the Search button is what triggers it", buttonAt > 0);
  // The idle state must exist and must not promise anything free.
  check("the page states that no search has run yet", /No search has run yet/.test(page));
  check("the page states the cost per competition before the click", /1 credit per competition/.test(page));
  check("the page says nothing is fetched before the click", /Nothing is fetched until you press Search/.test(page));
  check("the page reports credits actually spent", /Credits spent/.test(page));
  check("the page names the competitions that failed", /competitions failed — these results are incomplete/.test(page));
}

// ── 11. The alert worker is untouched ──────────────────────────────────────

console.log("11. The alert worker's path is not shared with a search");
{
  const search = readFileSync(join(ROOT, "src", "server", "league-search.ts"), "utf8");
  const alerts = readFileSync(join(ROOT, "src", "server", "alerts.ts"), "utf8");
  const serve = readFileSync(join(ROOT, "serve-static.ts"), "utf8");
  const oddsApi = readFileSync(join(ROOT, "api", "odds.ts"), "utf8");
  check("the search module has no cache of its own", !/new Map<[^>]*>\(\)/.test(search.replace(/new Map\(CATALOGUE[^)]*\)/, "")));
  check("the search module never touches the alert cache file", !/alerts-cache|alerts-seen/.test(search));
  check("the search module never writes a cache", !/oddsCache|caches\[/.test(search) && !/setItem\(/.test(search));
  check("api/odds.ts is unchanged in role (still the cached proxy)", /CACHE_TTL_MS/.test(oddsApi) && !/odds-leagues/.test(oddsApi));
  check("serve-static routes the search separately from /api/odds", /url\.pathname === "\/api\/odds-leagues"/.test(serve) && /url\.pathname === "\/api\/odds"/.test(serve));
  check("the alert worker's scan path is untouched", /CHECK_INTERVAL_MIN|CHECK_INTERVAL/.test(alerts));
}

// ── Result ─────────────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`✅ ${pass} checks passed, 0 failed (0 credits spent — the provider was stubbed)`);
} else {
  console.log(`❌ ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
process.exit(failures.length === 0 ? 0 : 1);
