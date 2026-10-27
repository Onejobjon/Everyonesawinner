/**
 * Proves the /oddsmatcher offers panel renders the pruned dataset and nothing
 * else. Run: bun scripts/test-offers-panel.ts
 *
 * It renders the real component server-side, so the assertions are on the DOM
 * the user gets — not on a copy of the intent.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import FreeBetsOffers from "../src/components/FreeBetsOffers";
import HowWeCheckOffers from "../src/pages/HowWeCheckOffers";
import FreeBets from "../src/pages/FreeBets";
import { MemoryRouter } from "react-router-dom";
import offersData from "../src/content/free-bets-offers.json";
import { licenceEvidence, licenceLine, NOT_QUOTED, type FreeBetOffer } from "../src/lib/free-bets";

const ROWS = offersData.offers as FreeBetOffer[];
const html = renderToStaticMarkup(createElement(FreeBetsOffers, { defaultOpen: true }));

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const count = (needle: string): number => html.split(needle).length - 1;

console.log("\nrendered set");
const rendered = [...html.matchAll(/data-bookmaker="([^"]+)"/g)].map((m) => m[1]);
const renderedSet = new Set(rendered);
const keptSet = new Set(ROWS.map((o) => o.bookmaker));

check("panel renders one row per kept offer", rendered.length === ROWS.length, `${rendered.length} rows vs ${ROWS.length}`);
check(`exactly ${ROWS.length} rows`, rendered.length === ROWS.length, String(rendered.length));
check(
  "rendered operator set === dataset operator set",
  renderedSet.size === keptSet.size && [...keptSet].every((b) => renderedSet.has(b)),
  `only in dataset: ${[...keptSet].filter((b) => !renderedSet.has(b)).join(", ") || "none"}`,
);

console.log("\npruned operators are gone");
const REMOVED = [
  "1xBet", "22Bet", "Betwinner", "Megapari", "Rabona", "CasinoDaddy", "Cobbler", "RedZone",
  "Betsafe", "Tipico", "ComeOn", "Mobilebet", "Bet-at-home", "EnergyBet", "SportNation",
  "FansBet", "BetBull", "Neo.bet", "RaceBets", "MansionBet", "Vegas Land", "PokerStars Sports",
];
const survivors = REMOVED.filter((name) => renderedSet.has(name));
check("none of the 22 removed operators render", survivors.length === 0, survivors.join(", "));

console.log("\nno profit column, no unearned licence tick");
const expectedTicks = ROWS.filter((o) => licenceEvidence(o).ok).length;
check(
  "UK tick count equals rows that carry licence evidence",
  count('data-testid="offers-row-uk-tick"') === expectedTicks,
  `${count('data-testid="offers-row-uk-tick"')} ticks vs ${expectedTicks} rows with evidence`,
);
check(
  "every row states that no profit figure is quoted",
  count(NOT_QUOTED) === ROWS.length,
  `${count(NOT_QUOTED)} of ${ROWS.length}`,
);
check("the panel does not print a £ profit figure", !/est\. profit<\/span>\s*<p[^>]*>£/.test(html));

console.log("\naudit fields are on the page");
const statusCount = (label: string): number => count(`>${label}</span>`);
const changed = ROWS.filter((o) => o.status === "changed").length;
const unverifiable = ROWS.filter((o) => o.status === "unverifiable").length;
check("re-checked rows are labelled as such", statusCount("re-checked — terms changed") === changed, String(statusCount("re-checked — terms changed")));
check("unverified rows are labelled as such", statusCount("unverified") === unverifiable, String(statusCount("unverified")));
const checkedDates = new Set(ROWS.map((o) => o.checked_on));
check(
  "each row shows the date it was checked (audit line + licence line)",
  [...checkedDates].every((d) => count(`checked ${d}`) >= ROWS.length),
  [...checkedDates].join(", "),
);

console.log("\nlicence evidence");
const verified = ROWS.filter((o) => o.licenceStatus === "verified");
check(
  "a tick appears only for rows whose licence was verified",
  count('data-testid="offers-row-uk-tick"') === verified.length,
  `${count('data-testid="offers-row-uk-tick"')} ticks vs ${verified.length} verified rows`,
);
check(
  "every verified row names its licensee, register account and check date",
  verified.every(
    (o) =>
      html.includes(`account ${o.registerAccount}`) &&
      html.includes(o.licensee || "\u0000") &&
      html.includes(`checked ${o.licenceCheckedOn}`),
  ),
);
check(
  "the licensee links to the public register",
  verified.every((o) => !o.registerUrl || html.includes(`href="${o.registerUrl}"`)),
);
check(
  "the licence line says it is not evidence the offer is live",
  html.includes("it is not evidence this offer is live"),
);
check(
  "no row claims an operator is unlicensed",
  !/unlicen[sc]ed (operator|bookmaker)/i.test(html),
);

// Absence must read as "we don't know", never as confirmation either way.
const synthetic = (patch: Partial<FreeBetOffer>): FreeBetOffer => ({
  ...(ROWS[0] as FreeBetOffer),
  ...patch,
});
check(
  "licenceStatus 'verified' + licensee + account earns the tick",
  licenceEvidence(synthetic({ licenceStatus: "verified" })).ok,
);
check(
  "licenceStatus 'unverified' earns no tick even with a licensee on file",
  !licenceEvidence(synthetic({ licenceStatus: "unverified" })).ok,
);
check(
  "a missing licenceStatus earns no tick",
  !licenceEvidence(synthetic({ licenceStatus: undefined })).ok,
);
check(
  "a verified status with no register account earns no tick",
  !licenceEvidence(synthetic({ licenceStatus: "verified", registerAccount: "" })).ok,
);
check(
  "the unverified line says we could not check, not that they are unlicensed",
  licenceLine(synthetic({ licenceStatus: "unverified" })).includes("could not check") &&
    !/unlicen[sc]ed/i.test(licenceLine(synthetic({ licenceStatus: "unverified" }))),
);


// ── the lead's integration assertions ──────────────────────────────────────
console.log("\nlicence integration");
const tickCount = count('data-testid="offers-row-uk-tick"');
check(`${ROWS.length} licence ticks on the real dataset`, tickCount === ROWS.length, String(tickCount));
check(
  'the words "licence not recorded" appear zero times on the real dataset',
  count("licence not recorded") === 0,
  String(count("licence not recorded")),
);
const licenceHrefs = [...html.matchAll(/<a[^>]*data-testid="offers-row-licence"[^>]*>/g)].map((m) => {
  const href = /href="([^"]+)"/.exec(m[0]);
  return href ? href[1] : "";
});
const expectedHrefs = ROWS.map((o) => o.registerUrl || "");
check(
  "every rendered licence line links to that row's registerUrl",
  licenceHrefs.length === ROWS.length && licenceHrefs.every((h, i) => h === expectedHrefs[i]),
  `${licenceHrefs.length} links for ${ROWS.length} rows`,
);
// Fail-closed still proven end to end: drop licenceStatus from one row and render.
const withoutStatus = ROWS.map((o, i) => (i === 0 ? { ...o, licenceStatus: undefined } : o));
const fallbackHtml = renderToStaticMarkup(
  createElement(FreeBetsOffers, { defaultOpen: true, offers: withoutStatus }),
);
check(
  "a row without licenceStatus renders as not recorded",
  (fallbackHtml.match(/data-testid="offers-row-licence-unknown"/g) || []).length === 1,
  String((fallbackHtml.match(/licence not recorded/g) || []).length),
);
check(
  `the other ${ROWS.length - 1} rows still show their licence line`,
  (fallbackHtml.match(/data-testid="offers-row-licence"/g) || []).length === ROWS.length - 1,
);

console.log("\nsearch and section filters survive");
check("search box is present", html.includes('placeholder="Search bookmakers or offers..."'));
check("All tab shows the row count", html.includes(`All (${ROWS.length})`));
check("UK/IE tab shows the UK count", html.includes(`UK/IE (${ROWS.filter((o) => o.section === "uk").length})`));
check("Global tab shows the global count", html.includes(`Global (${ROWS.filter((o) => o.section === "global").length})`));

console.log("\nthe component carries no operator list of its own");
const source = readFileSync(new URL("../src/components/FreeBetsOffers.tsx", import.meta.url), "utf8");
const leaked = ROWS.map((o) => o.bookmaker).filter((b) => source.includes(b));
check("no bookmaker name is hard-coded in the component", leaked.length === 0, leaked.join(", "));
check("component imports the dataset", source.includes('from "../content/free-bets-offers.json"'));


// ── the explainer page the panel links to ──────────────────────────────────
console.log("\n/how-we-check-offers");
const pageHtml = renderToStaticMarkup(
  createElement(MemoryRouter, null, createElement(HowWeCheckOffers, null)),
);
check("renders the approved heading", pageHtml.includes("How we check the offers"));
check("says a licence is not a promotion", pageHtml.toLowerCase().includes("a licence is not a promotion"));
check(
  "gives the reader the register search they can repeat",
  pageHtml.includes("public-register/businesses") && pageHtml.includes("business-search="),
);
check("says what unverifiable means", pageHtml.includes("we could not read this"));
check("quotes no expected-profit figure", !/£\s?\d/.test(pageHtml));
check("the panel footer links to the explainer", html.includes('href="/how-we-check-offers"'));

// ── /free-bets — the page a visitor can actually see without paying ───────
// The gap the lead found: the evidence was real but sat inside a title=
// tooltip, which does not exist on a phone or for a screen reader. These
// assertions are on the rendered page, so that cannot come back.
console.log("\n/free-bets (public page)");
const pub = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FreeBets, null)));

const pageRows = [...pub.matchAll(/data-bookmaker="([^"]+)"/g)].map((m) => m[1]);
check("the page renders every kept offer", pageRows.length === ROWS.length, `${pageRows.length} rows`);

const pubLinks = [...pub.matchAll(/<a\b[^>]*data-testid="free-bets-licence"[^>]*>/g)].map((m) => {
  const tag = m[0];
  return {
    href: (tag.match(/href="([^"]*)"/) || [])[1] || "",
    target: (tag.match(/target="([^"]*)"/) || [])[1] || "",
    rel: (tag.match(/rel="([^"]*)"/) || [])[1] || "",
    account: (tag.match(/data-register-account="([^"]*)"/) || [])[1] || "",
  };
});
check(`every row gets a register link (${ROWS.length})`, pubLinks.length === ROWS.length, String(pubLinks.length));
check(
  "every register link points at that row's registerUrl, in dataset order",
  pubLinks.length === ROWS.length && pubLinks.every((l, i) => l.href === ROWS[i].registerUrl),
  pubLinks.findIndex((l, i) => l.href !== ROWS[i].registerUrl) >= 0
    ? `row ${pubLinks.findIndex((l, i) => l.href !== ROWS[i].registerUrl)}`
    : `${pubLinks.length} links vs ${ROWS.length} rows`,
);
check(
  "every register link opens in a new tab with noopener noreferrer",
  pubLinks.every((l) => l.target === "_blank" && l.rel.includes("noopener") && l.rel.includes("noreferrer")),
);
check(
  `the visible licence sentence renders ${ROWS.length} times`,
  (pub.match(/Licensed by the Gambling Commission — /g) || []).length === ROWS.length,
  String((pub.match(/Licensed by the Gambling Commission — /g) || []).length),
);
check(
  "the licence account number is printed as text, not hidden in a tooltip",
  ROWS.every((o) => pub.includes(`account ${o.registerAccount}`)),
);
check(
  "the evidence survives with every title= attribute stripped",
  (() => {
    const noTitles = pub.replace(/ title="[^"]*"/g, "");
    return (
      (noTitles.match(/data-testid="free-bets-licence"/g) || []).length === ROWS.length &&
      (noTitles.match(/Licensed by the Gambling Commission — /g) || []).length === ROWS.length
    );
  })(),
);
check(
  "no row shows a UK licensed tick without the licence line and link beside it",
  (() => {
    const ticks = (pub.match(/data-testid="free-bets-uk-tick"/g) || []).length;
    if (ticks !== pubLinks.length) return false;
    // attribute each link to the row it sits in and require exactly one per row
    const slices = pageRows.map((name, i) => {
      const from = pub.indexOf(`data-bookmaker="${name}"`);
      const to = i + 1 < pageRows.length ? pub.indexOf(`data-bookmaker="${pageRows[i + 1]}"`) : pub.length;
      return pub.slice(from, to);
    });
    return slices.every((slice) =>
      slice.includes('data-testid="free-bets-licence"') && slice.includes("Licensed by the Gambling Commission —"),
    );
  })(),
);
check(
  "the licence line is visibly separate from the offer's own audit line",
  pub.includes("Licensed by the Gambling Commission — ") && pub.includes("not confirmation that the offer is running"),
);
check(
  "no row on the page claims an operator is unlicensed",
  !/not licensed|unlicensed (?!\.)/i.test(pub.replace(/that is not a statement that the operator is unlicensed/g, "")),
);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
