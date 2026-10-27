/**
 * Back/lay sanity-check test — src/lib/odds-sanity.ts + the transform-level
 * application in src/lib/odds-api.ts transformMatches().
 *
 * Run:  bun scripts/test-odds-sanity.ts
 *
 * The task this covers: the Odds API feed carries sentinel prices (1.00 / 451)
 * and cross-coverage artefacts where the bookmaker's back price and the
 * exchange's lay price describe different markets (real SHL examples:
 * Växjö Lakers back 5.50 / lay 2.56, HV71 back 1.70 / lay 1.50 — lay BELOW back).
 * Those rows must never reach a surface as a "profitable" opportunity.
 */
import {
  checkBackLayPair,
  isPlausiblePrice,
  isSentinelPrice,
  SENTINEL_HIGH,
  SENTINEL_LOW,
  BELOW_BACK_TOLERANCE,
} from "../src/lib/odds-sanity";
import { transformMatches, type Match } from "../src/lib/odds-api";
import { calcLay, calcFreeBetProfit, qualifiesForLay } from "../src/lib/odds";

let failures = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ── Feed fixtures ──────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
const NOW_ISO = new Date().toISOString();

type P = { name: string; price: number };
function market(key: string, outcomes: P[]) {
  return { key, last_update: NOW_ISO, outcomes };
}
function book(key: string, title: string, h2h: P[], h2hLay?: P[]) {
  const markets = [market("h2h", h2h)];
  if (h2hLay) markets.push(market("h2h_lay", h2hLay));
  return { key, title, last_update: NOW_ISO, markets };
}
function feedMatch(o: {
  id: string;
  sport_key: string;
  sport_title: string;
  home: string;
  away: string;
  bookmakers: unknown[];
}) {
  return {
    id: o.id,
    sport_key: o.sport_key,
    sport_title: o.sport_title,
    commence_time: FUTURE,
    home_team: o.home,
    away_team: o.away,
    bookmakers: o.bookmakers,
  };
}

const byName = (m: Match | undefined, name: string) =>
  m?.outcomes.find((o) => o.name.toLowerCase() === name.toLowerCase());

// ── 1. Price-level rules ───────────────────────────────────────────────────

console.log("1) Sentinel / plausible prices");
{
  assert(!isPlausiblePrice(1.0), "1.00 is not a usable price");
  assert(!isPlausiblePrice(SENTINEL_HIGH), "451 is not a usable price");
  assert(!isPlausiblePrice(1000), "1000 is not a usable price");
  assert(!isPlausiblePrice(0), "0 is not a usable price");
  assert(!isPlausiblePrice(-3), "negative is not a usable price");
  assert(!isPlausiblePrice(NaN), "NaN is not a usable price");
  assert(!isPlausiblePrice(Infinity), "Infinity is not a usable price");
  assert(isPlausiblePrice(1.01), "1.01 is usable (shortest possible price)");
  assert(isPlausiblePrice(2.5), "2.50 is usable");
  assert(isPlausiblePrice(450.99), "450.99 is usable (below the sentinel)");
  assert(isSentinelPrice(SENTINEL_LOW) && isSentinelPrice(SENTINEL_HIGH), "both sentinels recognised");
}

// ── 2. Pair rules ──────────────────────────────────────────────────────────

console.log("2) Back/lay pair rules");
{
  const tight = checkBackLayPair(2.1, 2.0);
  assert(tight.verdict === "ok" && !tight.suspect, "2.10 back / 2.00 lay is sane");

  const atFloor = checkBackLayPair(2.0, 2.0 * (1 - BELOW_BACK_TOLERANCE));
  assert(atFloor.verdict === "ok", "a lay exactly 10% below the back is still allowed (edge)");

  const arb = checkBackLayPair(3.0, 2.95);
  assert(arb.verdict === "ok", "small genuine arb-grade gap (3.00 / 2.95) is sane");

  const shl1 = checkBackLayPair(5.5, 2.56);
  assert(shl1.verdict === "lay_below_back" && shl1.suspect, "SHL Växjö 5.50 / 2.56 → suspect");
  assert(Boolean(shl1.reason?.includes("different coverage")), "reason explains the mismatch");

  const shl2 = checkBackLayPair(1.7, 1.5);
  assert(shl2.verdict === "lay_below_back" && shl2.suspect, "SHL HV71 1.70 / 1.50 → suspect");

  const sentinelLay = checkBackLayPair(2.0, 451);
  assert(sentinelLay.verdict === "sentinel_lay" && sentinelLay.suspect, "lay of 451 is a placeholder");

  const badBack = checkBackLayPair(451, 3.0);
  assert(badBack.verdict === "bad_back" && badBack.suspect, "back of 451 is a placeholder");

  const noLay = checkBackLayPair(2.0, null);
  assert(noLay.verdict === "no_lay" && !noLay.suspect, "no lay price is not 'suspect' — just unavailable");
}

// ── 3. Transform: sentinel back prices are dropped ─────────────────────────

console.log("3) transformMatches — sentinel back prices never win 'best price'");
const sentinelFeed = [
  feedMatch({
    id: "epl-1",
    sport_key: "soccer_epl",
    sport_title: "EPL",
    home: "Arsenal",
    away: "Chelsea",
    bookmakers: [
      book("bet365", "Bet365", [
        { name: "Arsenal", price: 2.5 },
        { name: "Draw", price: 3.4 },
        { name: "Chelsea", price: 3.0 },
      ]),
      // This bookmaker quotes the high sentinel for Arsenal — the old code
      // treated 451 as the best available price and invented a huge arb.
      book("williamhill", "William Hill", [
        { name: "Arsenal", price: 451 },
        { name: "Draw", price: 3.5 },
        { name: "Chelsea", price: 3.1 },
      ]),
      book(
        "betfair_ex_uk",
        "Betfair",
        [
          { name: "Arsenal", price: 2.6 },
          { name: "Draw", price: 3.5 },
          { name: "Chelsea", price: 3.1 },
        ],
        [
          { name: "Arsenal", price: 2.55 },
          { name: "Draw", price: 3.45 },
          { name: "Chelsea", price: 3.05 },
        ]
      ),
    ],
  }),
];
{
  const [m] = transformMatches(sentinelFeed as never);
  assert(Boolean(m), "match survives");
  const arsenal = byName(m, "Arsenal");
  assert(
    arsenal != null && arsenal.odds < 10,
    `Arsenal best back is a real price, not 451 (got ${arsenal?.odds})`
  );
  assert(arsenal?.bookmaker !== "William Hill", "the sentinel-quoting bookmaker is not the \"best\" price");
  assert(
    !m.outcomes.some((o) => o.odds >= SENTINEL_HIGH || o.odds <= SENTINEL_LOW),
    "no outcome carries a sentinel back price"
  );
  assert(
    m.outcomes.every((o) => !(o.bookmakerOdds ?? []).some((b) => b.odds >= SENTINEL_HIGH)),
    "per-bookmaker matrix has no sentinel rows"
  );
  assert(arsenal?.layOdds === 2.55, `genuine lay kept (got ${arsenal?.layOdds})`);
  assert(m.laysWithheld === undefined, "nothing withheld on a clean match");
}

// ── 4. Transform: cross-coverage artefacts have their lay withheld ─────────

console.log("4) transformMatches — cross-coverage artefacts are withheld");
const shlFeed = [
  feedMatch({
    id: "shl-1",
    sport_key: "icehockey_sweden_shl",
    sport_title: "SHL",
    home: "Växjö Lakers",
    away: "HV71",
    bookmakers: [
      book("bet365", "Bet365", [
        { name: "Växjö Lakers", price: 5.5 },
        { name: "HV71", price: 1.7 },
      ]),
      book(
        "betfair_ex_uk",
        "Betfair",
        [
          { name: "Växjö Lakers", price: 5.6 },
          { name: "HV71", price: 1.72 },
        ],
        [
          { name: "Växjö Lakers", price: 2.56 },
          { name: "HV71", price: 1.5 },
        ]
      ),
    ],
  }),
  // Same artefact shape on a soccer match — proves the guard is not
  // ice-hockey-specific (the feed mislabels coverage elsewhere too).
  feedMatch({
    id: "liga-1",
    sport_key: "soccer_spain_la_liga",
    sport_title: "La Liga",
    home: "Getafe",
    away: "Sevilla",
    bookmakers: [
      book("bet365", "Bet365", [
        { name: "Getafe", price: 5.5 },
        { name: "Sevilla", price: 1.7 },
      ]),
      book(
        "betfair_ex_uk",
        "Betfair",
        [
          { name: "Getafe", price: 5.6 },
          { name: "Sevilla", price: 1.72 },
        ],
        [
          { name: "Getafe", price: 2.56 },
          { name: "Sevilla", price: 1.5 },
        ]
      ),
    ],
  }),
  // Sentinel lay price — must not surface as a lay of 451.
  feedMatch({
    id: "bundesliga-1",
    sport_key: "soccer_germany_bundesliga",
    sport_title: "Bundesliga",
    home: "Mainz",
    away: "Köln",
    bookmakers: [
      book("bet365", "Bet365", [
        { name: "Mainz", price: 2.4 },
        { name: "Köln", price: 2.9 },
      ]),
      book(
        "betfair_ex_uk",
        "Betfair",
        [
          { name: "Mainz", price: 2.45 },
          { name: "Köln", price: 2.95 },
        ],
        [
          { name: "Mainz", price: 451 },
          { name: "Köln", price: 2.9 },
        ]
      ),
    ],
  }),
];
{
  const matches = transformMatches(shlFeed as never);
  assert(matches.length === 3, `all three fixtures survive (got ${matches.length})`);

  const shl = matches.find((m) => m.matchId === "shl-1");
  const vaxjo = byName(shl, "Växjö Lakers");
  // Ice hockey is excluded at the data layer before the sanity check even runs
  // (regulation-time backs vs overtime-inclusive lays), so its lay is null and
  // no "withheld" flag is set — the row simply has no lay price.
  assert(vaxjo?.layOdds === null, "SHL Växjö lay withheld (null)");
  assert(vaxjo?.laySuspect === undefined, "ice-hockey exclusion is not reported as a sanity withholding");
  assert(byName(shl, "HV71")?.layOdds === null, "SHL HV71 lay withheld (null)");
  assert(!qualifiesForLay(5.5, vaxjo?.layOdds ?? null), "SHL row does not qualify for the Lay Bet Finder");
  assert(calcLay(5.5, vaxjo?.layOdds ?? null, 20) === null, "no lay maths on a withheld row");
  assert(calcFreeBetProfit(5.5, vaxjo?.layOdds ?? null, 20) === null, "no free-bet maths on a withheld row");

  const liga = matches.find((m) => m.matchId === "liga-1");
  const getafe = byName(liga, "Getafe");
  assert(getafe?.layOdds === null && getafe?.laySuspect === true, "same artefact on La Liga is withheld");
  assert(Boolean(getafe?.laySuspectReason?.includes("different coverage")), "reason recorded for the UI");
  assert(!qualifiesForLay(5.5, getafe?.layOdds ?? null), "La Liga artefact cannot qualify");

  const bl = matches.find((m) => m.matchId === "bundesliga-1");
  // A sentinel lay quote is passed over as "no lay price" rather than surfaced
  // as a 451 lay, so the row simply has no lay — nothing to withhold, nothing
  // to flag, and no source falls back to it.
  assert(byName(bl, "Mainz")?.layOdds === null, "sentinel lay (451) never becomes the lay price");
  assert(byName(bl, "Mainz")?.laySuspect === undefined, "sentinel lay is treated as unavailable, not withheld");
  assert(byName(bl, "Köln")?.layOdds === 2.9, "the sane leg on the same match keeps its lay price");
  assert(bl?.laysWithheld === undefined, "nothing to withhold on that match");
}

// ── 5. Transform: an outcome with no usable back price anywhere ────────────

console.log("5) transformMatches — incomplete market is flagged, never priced");
const incompleteFeed = [
  feedMatch({
    id: "incomplete-1",
    sport_key: "soccer_italy_serie_a",
    sport_title: "Serie A",
    home: "Lazio",
    away: "Torino",
    bookmakers: [
      book("bet365", "Bet365", [
        { name: "Lazio", price: 2.1 },
        { name: "Draw", price: 3.3 },
        { name: "Torino", price: 451 },
      ]),
      book("williamhill", "William Hill", [
        { name: "Lazio", price: 2.15 },
        { name: "Draw", price: 3.35 },
        { name: "Torino", price: 451 },
      ]),
    ],
  }),
];
{
  const [m] = transformMatches(incompleteFeed as never);
  assert(Boolean(m), "match survives with two priced outcomes");
  assert(m.outcomes.length === 2, `no outcome for the withdrawn price (got ${m.outcomes.length})`);
  assert(m.outcomesWithheld === 1, `1 outcome withheld (got ${m.outcomesWithheld})`);
  assert(!m.outcomes.some((o) => o.odds >= SENTINEL_HIGH), "no sentinel price shown");
}

// ── 6. Ordinary market is untouched ───────────────────────────────────────

console.log("6) transformMatches — clean market passes through unchanged");
{
  const matches = transformMatches(sentinelFeed as never);
  const m = matches[0];
  assert(m.outcomes.length === 3, "all three outcomes kept");
  assert(m.outcomesWithheld === undefined, "nothing withheld");
  assert(m.outcomes.every((o) => o.layOdds !== null), "every outcome keeps its lay price");
  assert(m.outcomes.every((o) => o.laySuspect === undefined), "no row flagged suspect");
}

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("✓ all sanity assertions passed");
