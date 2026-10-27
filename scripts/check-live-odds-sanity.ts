/**
 * Live-feed check for the back/lay sanity rules (read-only, costs 1 odds-API
 * request). Run it after a deploy, or when a user reports a "too good to be
 * true" row.
 *
 *   bun scripts/check-live-odds-sanity.ts            # upcoming (all sports)
 *   bun scripts/check-live-odds-sanity.ts soccer_epl # a specific sport
 *
 * It fetches the raw upstream feed, counts the bad rows in it (sentinels,
 * lay-below-back artefacts), runs the same transform the site uses, and fails
 * loudly if any suspect pair survives into the transformed output.
 */
import { transformMatches } from "../src/lib/odds-api";
import { checkBackLayPair, isPlausiblePrice, SENTINEL_HIGH } from "../src/lib/odds-sanity";
import { ODDS_API_KEY } from "../src/server/odds-key";

const sport = process.argv[2] ?? "upcoming";
const url =
  sport === "upcoming"
    ? `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&oddsFormat=decimal`
    : `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h&oddsFormat=decimal`;

const res = await fetch(url);
console.log(`sport=${sport} status=${res.status} x-requests-remaining=${res.headers.get("x-requests-remaining")}`);
if (!res.ok) {
  console.error(`upstream error: ${await res.text()}`);
  process.exit(1);
}
const raw = (await res.json()) as any[];

let rawSentinels = 0;
let rawArtefacts = 0;
let rawSentinelLays = 0;
for (const m of raw) {
  for (const bm of m.bookmakers ?? []) {
    const h2h = bm.markets?.find((k: any) => k.key === "h2h");
    const lay = bm.markets?.find((k: any) => k.key === "h2h_lay");
    for (const o of h2h?.outcomes ?? []) {
      if (!isPlausiblePrice(o.price)) rawSentinels++;
      if (o.price >= SENTINEL_HIGH) rawSentinels++;
    }
    for (const o of lay?.outcomes ?? []) {
      if (o.price >= SENTINEL_HIGH || o.price <= 1) rawSentinelLays++;
      const back = h2h?.outcomes?.find((k: any) => k.name === o.name)?.price;
      if (back && isPlausiblePrice(back) && o.price < back * 0.9) rawArtefacts++;
    }
  }
}

const matches = transformMatches(raw as never);
let shown = 0;
let withLay = 0;
let withheld = 0;
let survivors = 0;
let iceHockey = 0;
for (const m of matches) {
  if (m.sportKey.startsWith("icehockey")) iceHockey++;
  for (const o of m.outcomes) {
    shown++;
    if (o.laySuspect) withheld++;
    if (o.layOdds != null) {
      withLay++;
      if (checkBackLayPair(o.odds, o.layOdds).suspect) {
        survivors++;
        console.error(
          `SURVIVED: ${m.home} v ${m.away} (${m.league}) ${o.name} back ${o.odds} lay ${o.layOdds}`
        );
      }
    }
  }
}

console.log(
  [
    `raw fixtures          : ${raw.length}`,
    `raw sentinel backs    : ${rawSentinels}`,
    `raw sentinel lays     : ${rawSentinelLays}`,
    `raw lay<back artefacts: ${rawArtefacts}`,
    `--- after transform ---`,
    `fixtures shown        : ${matches.length} (ice hockey: ${iceHockey})`,
    `outcome rows          : ${shown}`,
    `rows with a lay price : ${withLay}`,
    `lays withheld (sanity): ${withheld}`,
    `suspect rows shown    : ${survivors}`,
  ].join("\n")
);

if (survivors > 0) {
  console.error(`✗ ${survivors} suspect back/lay pair(s) reached the UI`);
  process.exit(1);
}
console.log("✓ no suspect back/lay pair survives the transform");
