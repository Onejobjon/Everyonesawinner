// Vercel serverless function: /api/odds proxy.
//
// ⚠️ RULE for anyone adding a server route: on the custom domain (Vercel), the
// ONLY way a server route exists is an `api/*.ts` function like this one. Vercel
// builds the repo with its own auto-detected static builder (vercel.json
// `framework: "vite"` + `outputDirectory: "dist"` + rewrite-all→index.html) —
// it NEVER runs build-vercel.sh or vercel-entry.ts, so render-entry intercepts
// are dead code there. Keep every new domain route in `api/`.
//
// Server-side only — the key never reaches the client bundle.
// SECURITY (2026-10-27): this file used to carry a committed fallback key. The
// repo is PUBLIC, so that value is compromised and was deleted. There is NO key
// in the source tree by design — the function reads ODDS_API_KEY from the
// environment and returns an explicit 503 when it is missing. Never put a
// literal back: scripts/scan-secrets.sh fails the build on a 32-hex string.

// Server-side cache (in-memory per warm instance). TTL 10 min — repeated
// /api/odds hits within that window serve the cached upstream body instead of
// re-fetching the-odds-api.com (protects the monthly credit allowance).
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { body: string; status: number; ok: boolean; ts: number }>();

// ── WHICH COMPETITIONS MAY BE ASKED FOR ─────────────────────────────────────
//
// SECURITY / COST (2026-11-02): `sport` used to be taken straight from the
// query string and pasted into the paid upstream URL, so every distinct string
// was a new cache key and a fresh provider credit. This endpoint is public on
// purpose (the free-bets page reads it with no login), so the answer is not
// "require a subscription" — it is a FINITE, server-controlled set. Anything
// outside this list is refused with a 400 and NOTHING is fetched: a rejected
// request costs zero credits.
//
// The list is the provider's own competition catalogue (src/data/sports-
// catalogue.json, which already excludes ice hockey) plus the all-sports
// "upcoming" feed. It is duplicated here because this deployment cannot import
// from `src/`; test/money-state.test.ts fails if the two copies disagree, so
// this one cannot rot. Change both together.
const ACCEPTED_SPORTS: ReadonlySet<string> = new Set([
  "upcoming", "americanfootball_cfl", "americanfootball_ncaaf",
  "americanfootball_ncaaf_championship_winner", "americanfootball_nfl",
  "americanfootball_nfl_super_bowl_winner", "aussierules_afl", "aussierules_aflw",
  "baseball_kbo", "baseball_mlb", "baseball_mlb_world_series_winner", "basketball_euroleague",
  "basketball_nba", "basketball_nba_championship_winner", "basketball_nbl", "basketball_ncaab",
  "basketball_ncaab_championship_winner", "basketball_wnba", "boxing_boxing",
  "cricket_international_t20", "cricket_odi", "cricket_test_match",
  "golf_masters_tournament_winner", "golf_pga_championship_winner",
  "golf_the_open_championship_winner", "golf_us_open_winner", "handball_germany_bundesliga",
  "mma_mixed_martial_arts", "politics_us_presidential_election_winner", "soccer_germany_liga3",
  "soccer_australia_aleague", "soccer_sweden_allsvenskan", "soccer_austria_bundesliga",
  "soccer_belgium_first_div", "soccer_brazil_campeonato", "soccer_brazil_serie_b",
  "soccer_germany_bundesliga", "soccer_germany_bundesliga2", "soccer_uefa_champs_league",
  "soccer_efl_champ", "soccer_uefa_europa_conference_league",
  "soccer_conmebol_copa_libertadores", "soccer_conmebol_copa_sudamericana",
  "soccer_denmark_superliga", "soccer_germany_dfb_pokal", "soccer_netherlands_eredivisie",
  "soccer_england_efl_cup", "soccer_poland_ekstraklasa", "soccer_norway_eliteserien",
  "soccer_uefa_europa_league", "soccer_germany_bundesliga_women", "soccer_japan_j_league",
  "soccer_korea_kleague1", "soccer_spain_la_liga", "soccer_spain_segunda_division",
  "soccer_league_of_ireland", "soccer_england_league1", "soccer_england_league2",
  "soccer_mexico_ligamx", "soccer_france_ligue_one", "soccer_france_ligue_two",
  "soccer_usa_mls", "soccer_epl", "soccer_russia_premier_league",
  "soccer_portugal_primeira_liga", "soccer_argentina_primera_division",
  "soccer_chile_campeonato", "soccer_saudi_arabia_pro_league", "soccer_spl",
  "soccer_italy_serie_a", "soccer_italy_serie_b", "soccer_china_superleague",
  "soccer_greece_super_league", "soccer_sweden_superettan", "soccer_switzerland_superleague",
  "soccer_turkey_super_league", "soccer_uefa_champs_league_women",
  "soccer_uefa_nations_league", "soccer_finland_veikkausliiga", "tennis_atp_swiss_indoors",
  "tennis_atp_vienna_open", "tennis_wta_pan_pacific_open"
]);

function acceptedSport(raw: string | null): string | null {
  if (raw == null || raw === "") return "upcoming"; // the historical default
  return ACCEPTED_SPORTS.has(raw) ? raw : null;
}

const REJECTED_SPORT_MESSAGE =
  "That competition isn't one we cover. Live odds are only served for our listed competitions and the all-sports feed.";

function respond(res: any, body: string, status: number, ok: boolean): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (ok) res.setHeader("cache-control", "public, max-age=300");
  res.end(body);
}

export default async function handler(req: any, res: any): Promise<void> {
  const host = (req.headers && req.headers.host) || "localhost";
  const url = new URL(req.url ?? "/api/odds", `https://${host}`);
  // Validate BEFORE the key check, before the platform fallback and before any
  // upstream fetch — this is the line that makes a rejected request free.
  const sport = acceptedSport(url.searchParams.get("sport"));
  if (!sport) {
    console.warn(`[odds] refused unsupported sport "${url.searchParams.get("sport")}" — nothing fetched`);
    respond(res, JSON.stringify({ error: "sport_not_supported", message: REJECTED_SPORT_MESSAGE }), 400, false);
    return;
  }
  // `Oddsapi` is the name the owner's platform Secret currently uses; accept it
  // as an alias so a misnamed secret cannot take the feed down.
  const key = (process.env.ODDS_API_KEY || process.env.Oddsapi || "").trim();
  if (!key) {
    // No key in THIS deployment (e.g. the custom-domain project has no env var
    // yet). Rather than break the domain, answer with the same live feed from
    // the platform deployment, which holds the key. No secret is copied here.
    const upstreamHost =
      process.env.PLATFORM_ODDS_URL || "https://515136800b641762e9aace79427eb7c4.ctonew.app";
    try {
      const proxied = await fetch(
        `${upstreamHost}/api/odds?sport=${encodeURIComponent(sport)}`,
        { headers: { accept: "application/json" } },
      );
      const body = await proxied.text();
      if (proxied.ok) {
        console.log("[odds-key] served via platform fallback (this deployment has no key)");
        respond(res, body, 200, true);
        return;
      }
      console.error(`[odds-key] platform fallback returned ${proxied.status}`);
    } catch (e) {
      console.error(`[odds-key] platform fallback failed: ${String(e)}`);
    }
    // Loud and honest: never a silent empty list.
    console.error("[odds-key] /api/odds refused — ODDS_API_KEY is not set in this environment");
    respond(
      res,
      JSON.stringify({
        error: "odds_unavailable",
        message:
          "Live odds are temporarily unavailable because the odds feed key is not configured on the server.",
      }),
      503,
      false,
    );
    return;
  }
  const target =
    sport === "upcoming"
      ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`
      : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${key}&regions=uk&markets=h2h&oddsFormat=decimal`;

  const hit = cache.get(target);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    respond(res, hit.body, hit.status, hit.ok);
    return;
  }

  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    // Only cache successful upstream responses — never pin a transient error.
    if (upstream.ok) {
      cache.set(target, { body, status: upstream.status, ok: true, ts: Date.now() });
    }
    respond(res, body, upstream.status, upstream.ok);
  } catch {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "odds proxy failed" }));
  }
}
