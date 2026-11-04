import { describe, expect, test } from "bun:test";
import { transformMatches } from "../src/lib/odds-api";
import {
  BRANDS,
  brandByBookmaker,
  brandBySlug,
  commissionDisclosure,
  goHref,
  goPath,
  hasAffiliateTags,
  hasReferralLinks,
  isReferralBrand,
  referralDisclosure,
  referralRowNote,
  taggedDestination,
} from "../src/lib/affiliates";
import offersData from "../src/content/free-bets-offers.json";
import { licenceEvidence, profitText, NOT_QUOTED, type FreeBetOffer } from "../src/lib/free-bets";
import { referringPath } from "../src/server/click-log";
import { readFileSync } from "node:fs";

/**
 * OUTBOUND LINKS — the commission rule the owner signed off.
 *
 * "Commission never influences which price we call best." A brand's affiliate tag
 * is money WE may receive; it must not be able to buy a row a place in the
 * results. This file proves that at the level where the choice is actually made:
 * the best-back-price selection in transformMatches.
 *
 * It also pins the two facts that keep today's site honest while no affiliate
 * arrangement exists: every tag is empty, so no tracking parameter is added and
 * no commission disclosure renders.
 */

const kickoff = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

/** Raw feed payload shaped like The Odds API's /odds response. */
const rawMatch = (bookmakers: unknown[]) => [
  {
    id: "evt-commission",
    sport_key: "soccer_epl",
    sport_title: "Premier League",
    commence_time: kickoff(),
    home_team: "Home FC",
    away_team: "Away FC",
    bookmakers,
  },
];

/**
 * A bookmaker row carrying every commercial field a feed or a future integration
 * might attach: a commission rate, an affiliate tag, a revenue share. None of
 * them is part of the odds; all of them are here so the selection has every
 * chance to (wrongly) read one.
 */
const bm = (
  key: string,
  title: string,
  prices: Record<string, number>,
  commercial: Record<string, unknown> = {},
) => ({
  key,
  title,
  last_update: new Date().toISOString(),
  commission: 0.3,
  affiliateTag: "btag=secret123",
  revenueShare: 0.25,
  ...commercial,
  markets: [
    {
      key: "h2h",
      last_update: new Date().toISOString(),
      outcomes: Object.entries(prices).map(([name, price]) => ({
        name,
        price,
        // The same fields at outcome level, where a price is actually read.
        commission: 0.3,
        affiliateTag: "btag=secret123",
      })),
    },
  ],
});

describe("best-price selection ignores commission", () => {
  test("the highest price wins even when a rival pays us more", () => {
    // William Hill 2.60 pays us 30%; Paddy Power 2.75 pays us nothing.
    // The best price is 2.75 and the row must say so.
    const matches = transformMatches(
      rawMatch([
        bm("williamhill", "William Hill", { "Home FC": 2.6, "Away FC": 1.72 }),
        bm("paddypower", "Paddy Power", { "Home FC": 2.75, "Away FC": 1.7 }, { commission: 0 }),
      ]) as Parameters<typeof transformMatches>[0],
    );
    const home = matches[0].outcomes.find((o) => o.name === "Home FC")!;
    expect(home.odds).toBe(2.75);
    expect(home.bookmaker).toBe("Paddy Power");
    expect(home.bookmakerKey).toBe("paddypower");
  });

  test("a bigger commission never beats a bigger price", () => {
    // The commissioned book has the LOWER price; a commission-aware selector
    // would pick it (0.3 × 2.60 vs 0 × 2.75). The best price must still win.
    const matches = transformMatches(
      rawMatch([
        bm("bet365", "Bet365", { "Home FC": 2.6, "Away FC": 1.72 }, { commission: 0.5 }),
        bm("skybet", "Sky Bet", { "Home FC": 2.62, "Away FC": 1.7 }, { commission: 0 }),
      ]) as Parameters<typeof transformMatches>[0],
    );
    const home = matches[0].outcomes.find((o) => o.name === "Home FC")!;
    expect(home.bookmaker).toBe("Sky Bet");
    expect(home.odds).toBe(2.62);
  });

  test("adding commission fields changes nothing about the result", () => {
    // The same feed twice — once with the commercial fields, once without. The
    // transform's output must be identical, field for field: commission is not
    // an input to anything it decides.
    const withFields = rawMatch([
      bm("williamhill", "William Hill", { "Home FC": 2.6, "Away FC": 1.72, Draw: 3.3 }),
      bm("paddypower", "Paddy Power", { "Home FC": 2.5, "Away FC": 1.8, Draw: 3.2 }),
      bm("bet365", "Bet365", { "Home FC": 2.55, "Away FC": 1.75, Draw: 3.4 }),
    ]);
    const stripped = JSON.parse(
      JSON.stringify(withFields, (k, v) =>
        ["commission", "affiliateTag", "revenueShare"].includes(k) ? undefined : v,
      ),
    );
    const a = transformMatches(withFields as Parameters<typeof transformMatches>[0]);
    const b = transformMatches(stripped as Parameters<typeof transformMatches>[0]);
    expect(a).toEqual(b);
    // Sanity: the comparison is of real rows, not two empty lists.
    expect(a.length).toBe(1);
    expect(a[0].outcomes.length).toBe(3);
  });
});

describe("no affiliate tag exists today, so nothing claims we are paid", () => {
  test("every brand's tag is empty and no tracking parameter is added", () => {
    expect(BRANDS.length).toBeGreaterThan(30);
    for (const brand of BRANDS) {
      expect(brand.tag).toBe("");
      // Byte-for-byte the configured destination: no `?`, no invented parameter.
      expect(taggedDestination(brand)).toBe(brand.destination);
    }
  });

  test("the commission disclosure renders nothing while no tag exists", () => {
    expect(hasAffiliateTags()).toBe(false);
    expect(commissionDisclosure()).toBeNull();
  });

  test("a tag, once configured, is appended to the destination — not invented", () => {
    const brand = brandBySlug("bet365")!;
    expect(taggedDestination({ ...brand, tag: "btag=abc123" })).toBe(
      "https://www.bet365.com?btag=abc123",
    );
    // A destination that already has a query string keeps it.
    const withQuery = { ...brand, destination: "https://example.com/join?ref=1", tag: "btag=abc123" };
    expect(taggedDestination(withQuery)).toBe("https://example.com/join?ref=1&btag=abc123");
    // A leading "?" in the configured tag is tolerated, never doubled.
    expect(taggedDestination({ ...brand, tag: "?btag=abc123" })).toBe(
      "https://www.bet365.com?btag=abc123",
    );
  });
});

describe("the link register matches the offers it serves", () => {
  test("every listed offer has a /go/<slug> address pointing where its row points", () => {
    for (const offer of offersData.offers as { bookmaker: string; url: string }[]) {
      const path = goPath(offer.bookmaker);
      expect(path).not.toBeNull();
      expect(path!.startsWith("/go/")).toBe(true);
      // The register's destination is the row's own URL — one address, not two.
      expect(brandBySlug(path!.slice("/go/".length))!.destination).toBe(offer.url);
      expect(goHref(offer.bookmaker, "https://fallback.invalid")).toBe(path);
    }
    // An unknown brand falls back rather than inventing a slug that would 404.
    expect(goPath("No Such Bookmaker")).toBeNull();
    expect(goHref("No Such Bookmaker", "https://www.bet365.com")).toBe("https://www.bet365.com");
  });

  test("the click log keeps a path and nothing else", () => {
    // Our own page: the path only — no host, no query string (which could carry
    // someone's email address).
    expect(referringPath("https://www.everyonesawinner.uk/free-bets?email=a@b.com")).toBe("/free-bets");
    expect(referringPath("https://515136800b641762e9aace79427eb7c4-dev.cto.site/how-we-check-offers")).toBe(
      "/how-we-check-offers",
    );
    // Another site is not one of our pages — recorded as unknown, not guessed.
    expect(referringPath("https://www.google.com/search?q=matched+betting")).toBe("");
    expect(referringPath(null)).toBe("");
    expect(referringPath("not a url")).toBe("");
  });
});

/**
 * THE MRQ REFERRAL LINK — a material interest, so it is disclosed and proved.
 *
 * The owner gave us his own MrQ refer-a-friend link on 2026-11-04. It is not an
 * affiliate tag (nothing is appended, we are paid by no network), but signing up
 * through it rewards the owner personally. These tests hold three things
 * together: the row carries real licence evidence like every other row; the
 * disclosure text exists and is generated from the link register, so it cannot
 * be silently dropped; and no OTHER brand has acquired a tag or a referral,
 * which is what makes the sentence "no other link carries one" true.
 */
describe("the owner's MrQ referral link is disclosed, not hidden", () => {
  const rows = offersData.offers as FreeBetOffer[];
  const mrq = rows.find((r) => r.bookmaker === "MrQ");

  test("MrQ is in the dataset with the same licence evidence as every other row", () => {
    expect(mrq).toBeDefined();
    const row = mrq as FreeBetOffer;
    // (a) licensee + register account + register URL, exactly like the rest.
    expect(row.licensee?.trim()).toBe("Tek Fox Ltd");
    expect(row.registerAccount?.trim()).toBe("60629");
    expect(row.registerUrl || "").toContain("gamblingcommission.gov.uk");
    expect(row.registerUrl || "").toContain("60629");
    expect(row.licenceStatus).toBe("verified");
    expect(licenceEvidence(row).ok).toBe(true);
    expect(row.checked_on).toBe("2026-11-04");
    // No invented profit figure: the row quotes nothing, like every other row.
    expect(row.estProfit ?? "").toBe("");
    expect(profitText(row).text).toBe(NOT_QUOTED);
  });

  test("every row claiming a verified licence can show who and which account", () => {
    for (const row of rows.filter((r) => r.licenceStatus === "verified")) {
      expect((row.licensee || "").trim().length).toBeGreaterThan(0);
      expect((row.registerAccount || "").trim().length).toBeGreaterThan(0);
      expect((row.registerUrl || "").trim()).toContain("gamblingcommission.gov.uk");
    }
  });

  test("the MrQ operator link is the owner's referral address, reached through /go/mrq", () => {
    const brand = brandByBookmaker("MrQ");
    expect(brand).toBeDefined();
    expect(brand!.slug).toBe("mrq");
    expect(brand!.referral).toBe(true);
    expect(brand!.destination).toBe("https://mrq.com/invited/bikehuta9?src=popup");
    // The row and the register are one address, not two.
    expect(brand!.destination).toBe(mrq!.url);
    expect(goPath("MrQ")).toBe("/go/mrq");
    expect(goHref("MrQ", "https://fallback.invalid")).toBe("/go/mrq");
    // A referral link is not a tag: nothing is appended to it.
    expect(brand!.tag).toBe("");
    expect(taggedDestination(brand!)).toBe(brand!.destination);
    expect(isReferralBrand("MrQ")).toBe(true);
    expect(isReferralBrand("Bet365")).toBe(false);
  });

  test("(b) the disclosure text exists while a referral destination is configured", () => {
    expect(hasReferralLinks()).toBe(true);
    const text = referralDisclosure();
    expect(text).not.toBeNull();
    expect(text!).toContain("MrQ");
    expect(text!).toContain("referral link");
    expect(text!).toMatch(/reward/i);
    // It must not repeat the old, now-false claim that we earn nothing at all.
    expect(text!).not.toMatch(/earn nothing/i);
    // The row-level note is there for the same reason.
    const note = referralRowNote("MrQ");
    expect(note).not.toBeNull();
    expect(note!).toMatch(/referral/i);
    expect(note!).toMatch(/reward/i);
    expect(referralRowNote("Bet365")).toBeNull();
  });

  test("no other link carries a referral or an affiliate tag — the claim stays true", () => {
    for (const brand of BRANDS) {
      if (brand.bookmaker === "MrQ") continue;
      expect(brand.referral ?? false).toBe(false);
      expect(brand.tag).toBe("");
      expect(taggedDestination(brand)).toBe(brand.destination);
    }
    // A referral link is not an affiliate arrangement: the commission
    // disclosure still stays silent, because nobody is paying us a commission.
    expect(hasAffiliateTags()).toBe(false);
    expect(commissionDisclosure()).toBeNull();
  });

  test("the transparency page says the same thing as the code", () => {
    const md = readFileSync(new URL("../src/content/how-we-check-offers.md", import.meta.url), "utf8");
    // The sentence that was true until this link existed is gone.
    expect(md).not.toContain("Today no link carries an affiliate tag");
    expect(md).not.toMatch(/so we earn nothing from them/);
    // And the page now names the one link that does pay the owner.
    expect(md).toContain("MrQ");
    expect(md).toMatch(/owner's own referral link/);
    expect(md).toMatch(/No other link carries a referral or affiliate tag/);
  });
});
