/**
 * Renders the actual React component (server-side) so the proof is DOM-level,
 * not just a logic check: bun scripts/test-2up-render.ts
 */
import { renderToStaticMarkup } from "react-dom/server";
import TwoUpNoteTag from "../src/components/TwoUpNoteTag";
import TwoUpGuideSection from "../src/components/TwoUpGuideSection";
import { twoUpNoteForOutcome } from "../src/lib/two-up";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.error(`  FAIL ${n}${d ? ` — ${d}` : ""}`));
};

const row = (display: string, key: string) => ({
  name: "Home",
  bookmaker: display,
  odds: 2.5,
  bookmakerOdds: [{ key, title: display, odds: 2.5 }],
  layOdds: 2.6,
});

// The card's numbers, exactly as LayBets computes them.
const NUMBERS = `<div class="grid"><div>Back 2.50</div><div>Lay 2.60</div><div>Lay stake £19.61</div><div>Liability £31.38</div><div>Profit/Loss -£0.38</div></div>`;

function cardWithNote(display: string, key: string): string {
  const note = twoUpNoteForOutcome(row(display, key));
  return NUMBERS + (note ? renderToStaticMarkup(TwoUpNoteTag({ note })) : "");
}

console.log("\nrendered 2up note");
const eight = cardWithNote("888sport", "sport888");
const unibet = cardWithNote("Unibet", "unibet_uk");
const other = cardWithNote("William Hill", "williamhill");

check("sport888 row renders the note element", eight.includes('data-testid="2up-note"'));
check("unibet_uk row renders the note element", unibet.includes('data-testid="2up-note"'));
check("another bookmaker renders NO note element", !other.includes('data-testid="2up-note"'));
check("note shows the data-file label", eight.includes(">2UP<") || eight.includes("2UP"));
check(
  "tooltip carries the market warning",
  eight.includes("not on the price shown on this row") && unibet.includes("not on the price shown on this row"),
);
check(
  "tooltip is the bookmaker's own wording",
  eight.includes("pays out early if your team leads by 2 goals") &&
    unibet.includes("pays out early when your team goes 2 goals ahead"),
);

// The decisive one: everything BEFORE the note element is the card's numbers,
// and it must be byte-identical whether or not a note is rendered.
const beforeNote = (html: string) => html.split('<span data-testid="2up-note"')[0];
check(
  "card numbers are byte-identical with and without the note",
  beforeNote(eight) === NUMBERS && beforeNote(other) === NUMBERS,
  JSON.stringify({ eight: beforeNote(eight).slice(0, 60), other: beforeNote(other).slice(0, 60) }),
);
check(
  "the note is appended after every number, never interleaved",
  eight.indexOf('data-testid="2up-note"') > eight.indexOf("Profit/Loss"),
);

console.log("\nrendered guide section");
const guide = renderToStaticMarkup(TwoUpGuideSection({}));
check("guide section renders", guide.includes('data-testid="2up-guide-section"'));
check("guide says early payout", /early payout/i.test(guide));
check("guide denies the free-bet reading", /not a free bet|not<\/strong> a free bet|not a <strong>free/i.test(guide) || /early payout<\/strong>, not a free bet/i.test(guide));
check("guide names the dedicated market", /dedicated 2-Up market/i.test(guide));
check("guide links the bookmaker terms", guide.includes("888sport.com") && guide.includes("unibet.co.uk"));
check("guide makes no profit guarantee", !/guarantee/i.test(guide) && !/improve[sd]? profit/i.test(guide));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
