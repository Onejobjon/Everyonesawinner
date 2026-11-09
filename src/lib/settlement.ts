/**
 * SETTLEMENT RULE — does a bookmaker back price and an exchange lay price
 * describe the SAME event?
 *
 * OWNER-REPORTED DEFECT (2026-11-09, verbatim): "Telegram alerts. Issue with
 * odds. Cup game, may go to extra time but the casumo odds used are the win in
 * 90mins odds." A green alert quoted Casumo's regulation-time price against a
 * lay that could settle after extra time or on penalties, so the "profit" was
 * not a profit at all: the two legs pay out on different results.
 *
 * WHY THE FEED CANNOT ANSWER THIS ITSELF (proven from a live payload, 2026-11-09,
 * soccer_fa_cup — Plymouth Parkway FC v Berkhamsted FC):
 *   • the only market keys offered are "h2h" and "h2h_lay";
 *   • no market carries a `description` (the field is absent, not "Match Odds");
 *   • the lay market's outcome names are identical to the back market's
 *     ("Berkhamsted FC", "Plymouth Parkway FC", "Draw") — a Draw is listed even
 *     on the exchange side, so market SHAPE cannot tell 90 minutes from
 *     to-qualify either.
 * So on a knockout tie there is nothing in the payload that proves the two legs
 * settle on the same result. The rule therefore errs toward SILENCE: if the two
 * legs cannot be proven to settle identically, no lay price is published at all.
 * Nulling the lay price at the data layer (exactly as ice hockey has always
 * been handled) means no surface can resurrect the pair — the alert worker, the
 * Instant Wins feed and the Lay Bet Finder all read `layOdds`.
 *
 * WHO IS EXCLUDED, AND WHY
 *   • Ice hockey (all competitions) — bookmaker prices are 60-minute, exchange
 *     prices include overtime and the shoot-out.
 *   • Knockout football — a tie level after 90 minutes goes to extra time and
 *     then penalties, so "the winner" and "the winner in 90 minutes" are two
 *     different bets. Excluded by NAME (below) and, as a net for anything not
 *     named, by the words cup/copa/coupe/pokal/trophy/shield/play-off/
 *     qualifier/knockout in the competition key or title.
 *   • The UEFA club competitions and the international tournaments: their
 *     league/group phase settles in 90 minutes but their knockout rounds do not,
 *     and the feed does not say which phase a fixture belongs to. Not provable
 *     ⇒ silent.
 * What is NOT excluded: ordinary league football (and every other sport with a
 * single settlement rule), where both legs settle on the same final result.
 */

/** Short line for the site: why a fixture is missing from a lay-priced list. */
export const SETTLEMENT_NOTE =
  "Cup ties and ice hockey are left out of lay prices: on those, a bookmaker's " +
  "90-minute price and the exchange's price can settle on different results, so " +
  "we cannot prove the two legs match.";

export interface SettlementProof {
  /** True only when both legs are proven to settle on the same result. */
  proven: boolean;
  /** One short, quotable reason when not proven; null when proven. */
  reason: string | null;
}

const PROVEN: SettlementProof = { proven: true, reason: null };

/**
 * Competitions excluded BY NAME, so the list is auditable rather than a guess at
 * a regex. The word net below catches these too; both are kept deliberately.
 */
export const NAMED_KNOCKOUT_COMPETITIONS: readonly string[] = [
  // England
  "soccer_england_efl_cup",
  "soccer_fa_cup",
  "soccer_england_efl_trophy",
  // Germany / Spain / France / Italy
  "soccer_germany_dfb_pokal",
  "soccer_spain_copa_del_rey",
  "soccer_france_coupe_de_france",
  "soccer_italy_coppa_italia",
  // UEFA club competitions — knockout rounds settle differently from the
  // league phase, and the feed does not say which phase a fixture is in.
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_conference_league",
  "soccer_uefa_champs_league_qualification",
  "soccer_uefa_europa_league_qualification",
  "soccer_uefa_conference_league_qualification",
  // South America
  "soccer_conmebol_copa_libertadores",
  "soccer_conmebol_copa_sudamericana",
  // International tournaments (knockout stage after the group phase)
  "soccer_fifa_world_cup",
  "soccer_uefa_euro",
  "soccer_conmebol_copa_america",
  "soccer_africa_cup_of_nations",
];

/** The net for anything not named above: a knockout competition, by its words. */
const KNOCKOUT_WORDS =
  /(cup|copa|coupe|pokal|trophy|shield|knockout|knock-out|play-?off|qualif|super\s?cup|coppa)/i;

/** Is this competition a knockout one whose result can change after 90 minutes? */
export function isKnockoutFootball(sportKey: string, leagueTitle = ""): boolean {
  const key = (sportKey || "").trim().toLowerCase();
  if (!key.startsWith("soccer")) return false;
  const title = (leagueTitle || "").trim().toLowerCase();
  if (NAMED_KNOCKOUT_COMPETITIONS.some((k) => key === k || key.startsWith(`${k}_`))) {
    return true;
  }
  return KNOCKOUT_WORDS.test(key) || KNOCKOUT_WORDS.test(title);
}

/**
 * The rule itself. Given a fixture's sport key and competition title, is a
 * bookmaker back price and an exchange lay price on the same outcome proven to
 * settle on the same result?
 */
export function settlementProofFor(sportKey: string, leagueTitle = ""): SettlementProof {
  const key = (sportKey || "").trim().toLowerCase();
  if (key.startsWith("icehockey")) {
    return {
      proven: false,
      reason:
        "bookmaker prices are for 60 minutes while the exchange price includes overtime and the shoot-out",
    };
  }
  if (isKnockoutFootball(key, leagueTitle)) {
    return {
      proven: false,
      reason:
        "a knockout tie can be settled after extra time or on penalties, so a 90-minute price and the exchange price are different bets",
    };
  }
  return PROVEN;
}

/**
 * Second, independent proof, and it needs no competition list: the exchange's
 * market must list every outcome the bookmaker's market lists. On a football
 * tie, a "to qualify" market has two outcomes and no Draw — so when the
 * bookmaker prices Home/Draw/Away and the exchange lists only Home/Away, the two
 * are describing different bets and must not be published.
 */
export function layMarketCoversBackMarket(
  backOutcomeNames: readonly string[],
  layOutcomeNames: readonly string[],
): boolean {
  const lay = new Set(layOutcomeNames.map((n) => (n || "").trim().toLowerCase()));
  return backOutcomeNames.every((n) => lay.has((n || "").trim().toLowerCase()));
}
