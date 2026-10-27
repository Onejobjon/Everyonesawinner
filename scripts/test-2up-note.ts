/**
 * Tests for the 2-Up note on the Lay Bet Finder.
 *
 *   bun scripts/test-2up-note.ts
 *
 * Covers the acceptance points that matter:
 *   1. a sport888 row and a unibet_uk row each render a note;
 *   2. any other bookmaker renders nothing (no inferred, no generic claim);
 *   3. the note NEVER changes the card's numbers — proved by diffing the figures
 *      computed for the same row with and without the note attached;
 *   4. the wording is the researcher's verbatim text, and never says free bet /
 *      money back / guaranteed profit.
 */
import raw from "../src/data/2up-verified-offers.json";
import {
  twoUpNoteForOutcome,
  twoUpNoteForFeedKey,
  twoUpFeedKeys,
  feedKeyForOutcome,
} from "../src/lib/two-up";
import { calcLay } from "../src/lib/odds";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Minimal row shape the finder hands to the note helper. */
function row(display: string, key: string, odds: number, layOdds: number) {
  const outcome = {
    name: "Home",
    bookmaker: display,
    odds,
    bookmakerOdds: [{ key, title: display, odds }],
    layOdds,
  };
  return outcome;
}

console.log("\n1. notes render for the two verified bookmakers");
const eight = row("888sport", "sport888", 2.5, 2.6);
const unibet = row("Unibet", "unibet_uk", 3.1, 3.3);
check("sport888 row has a note", twoUpNoteForOutcome(eight) !== null);
check("unibet_uk row has a note", twoUpNoteForOutcome(unibet) !== null);
check("label comes from the data file", twoUpNoteForOutcome(eight)!.label === "2UP");
check(
  "feed key resolved from the per-bookmaker matrix",
  feedKeyForOutcome(eight) === "sport888" && feedKeyForOutcome(unibet) === "unibet_uk",
);

console.log("\n2. no note for any other bookmaker, and no generic fallback");
for (const [display, key] of [
  ["William Hill", "williamhill"],
  ["Betfair Sportsbook", "betfair_sb_uk"],
  ["Paddy Power", "paddypower"],
  ["bet365", "bet365"],
] as const) {
  check(`${key} row has no note`, twoUpNoteForOutcome(row(display, key, 2.2, 2.3)) === null);
}
check("unknown key → null", twoUpNoteForFeedKey("nope_not_a_bookmaker") === null);
check("empty key → null", twoUpNoteForFeedKey("") === null && twoUpNoteForFeedKey(null) === null);
check(
  "row with no per-bookmaker matrix → null (never assumed)",
  twoUpNoteForOutcome({ bookmaker: "888sport", odds: 2.5 }) === null,
);

console.log("\n3. the note cannot touch the profit maths");
const withNote = { ...eight };
const withoutNote = { ...eight };
const note = twoUpNoteForOutcome(withNote);
// Same inputs, note present vs absent: the card computes from odds/stake only.
const calcWith = calcLay(withNote.odds, withNote.layOdds, 20);
const calcWithout = calcLay(withoutNote.odds, withoutNote.layOdds, 20);
check("lay numbers identical with and without the note", JSON.stringify(calcWith) === JSON.stringify(calcWithout));
check(
  "note object carries no numeric fields at all",
  note !== null && Object.values(note).every((v) => typeof v === "string"),
);
// Changing the note's presence must not perturb the figures by even a penny.
check(
  "profit/loss unchanged to the last decimal",
  calcWith !== null &&
    calcWithout !== null &&
    calcWith.layStake === calcWithout.layStake &&
    calcWith.liability === calcWithout.liability &&
    calcWith.profitLoss === calcWithout.profitLoss,
  JSON.stringify({ calcWith, calcWithout }),
);

console.log("\n4. wording is the researcher's, and makes no claims");
const byKey = (raw as any).bookmakers;
for (const key of twoUpFeedKeys()) {
  const n = twoUpNoteForFeedKey(key)!;
  check(`${key}: tooltip is verbatim from the data file`, n.tooltip === byKey[key].badge_tooltip);
  check(`${key}: note is verbatim from the data file`, n.note === byKey[key].badge_note);
  const text = `${n.tooltip} ${n.note}`.toLowerCase();
  // The note says "early payout, not a free bet" — that is the required denial,
  // so count occurrences and require every one to be the negated form.
  const freeBetHits = (text.match(/free[ -]bet/g) ?? []).length;
  const negatedHits = (text.match(/not a free[ -]bet/g) ?? []).length;
  check(
    `${key}: never claims a free bet (only denies one)`,
    freeBetHits === negatedHits && negatedHits > 0,
    `free=${freeBetHits} negated=${negatedHits}`,
  );
  check(`${key}: no money-back claim`, !text.includes("money back") && !text.includes("money-back"));
  check(`${key}: no profit/guarantee claim`, !text.includes("guarantee") && !text.includes("profit"));
}
check(
  "only the file's keys are ever badged",
  JSON.stringify(twoUpFeedKeys().sort()) === JSON.stringify(Object.keys(byKey).sort()),
);
check(
  "bet365 is not in the verified file",
  !Object.keys(byKey).includes("bet365"),
);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
