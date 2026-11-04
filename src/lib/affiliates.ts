/**
 * The affiliate/outbound-link register — ONE place that says where a bookmaker
 * link goes, and whether we are paid for it.
 *
 * Every operator link on the site points at `/go/<slug>` rather than straight at
 * the bookmaker, so a click is logged once (slug, time, referring path — nothing
 * personal) and the destination can change in one place.
 *
 * THE TAG RULE (owner directive 2026-11-03): `tag` is empty for every brand
 * today because we have no affiliate arrangement with anyone. While it is empty,
 * `/go/<slug>` redirects to `destination` EXACTLY as written — no tracking
 * parameter is invented. When a real tag arrives it is appended here as a query
 * fragment ("btag=abc123"), and only then does the commission disclosure start
 * rendering (see `commissionDisclosure`), because only then is it true.
 *
 * A tag is a commercial fact, never an input to pricing: nothing that chooses a
 * "best price" may read this file. See test/affiliate-commission-neutral.test.ts.
 */

export interface AffiliateBrand {
  /** Public slug — the `/go/<slug>` address. Stable: never rename a live slug. */
  slug: string;
  /** Exact bookmaker name as it appears in content/free-bets-offers.json. */
  bookmaker: string;
  /** The operator's own page the click lands on. */
  destination: string;
  /**
   * Affiliate tag, as a query fragment without a leading `?` or `&`
   * (e.g. "btag=abc123&affid=7"). "" means no affiliate arrangement.
   */
  tag: string;
  /**
   * True when `destination` is the owner's OWN referral link (a refer-a-friend
   * address with the owner as referrer) rather than an affiliate-network tag.
   *
   * It is a material interest, so it is disclosed in plain English wherever the
   * link appears — see `referralDisclosure()`. It is deliberately NOT a `tag`:
   * nothing is appended to the destination, and `hasAffiliateTags()` stays about
   * paid affiliate arrangements only.
   */
  referral?: boolean;
}

export const BRANDS: readonly AffiliateBrand[] = [
  {
    slug: "bet365",
    bookmaker: "Bet365",
    destination: "https://www.bet365.com",
    tag: "",
  },
  {
    slug: "sky-bet",
    bookmaker: "Sky Bet",
    destination: "https://www.skybet.com",
    tag: "",
  },
  {
    slug: "william-hill",
    bookmaker: "William Hill",
    destination: "https://www.williamhill.com",
    tag: "",
  },
  {
    slug: "paddy-power",
    bookmaker: "Paddy Power",
    destination: "https://www.paddypower.com",
    tag: "",
  },
  {
    slug: "betfair-sportsbook",
    bookmaker: "Betfair Sportsbook",
    destination: "https://www.betfair.com/sport",
    tag: "",
  },
  {
    slug: "betfred",
    bookmaker: "Betfred",
    destination: "https://www.betfred.com",
    tag: "",
  },
  {
    slug: "ladbrokes",
    bookmaker: "Ladbrokes",
    destination: "https://www.ladbrokes.com",
    tag: "",
  },
  {
    slug: "coral",
    bookmaker: "Coral",
    destination: "https://www.coral.co.uk",
    tag: "",
  },
  {
    slug: "unibet",
    bookmaker: "Unibet",
    destination: "https://www.unibet.co.uk",
    tag: "",
  },
  {
    slug: "betvictor",
    bookmaker: "BetVictor",
    destination: "https://www.betvictor.com",
    tag: "",
  },
  {
    slug: "spreadex",
    bookmaker: "SpreadEx",
    destination: "https://www.spreadex.com/sports/offers/",
    tag: "",
  },
  {
    slug: "boylesports",
    bookmaker: "Boylesports (IE)",
    destination: "https://www.boylesports.com",
    tag: "",
  },
  {
    slug: "888sport",
    bookmaker: "888sport",
    destination: "https://www.888sport.com",
    tag: "",
  },
  {
    slug: "betway",
    bookmaker: "Betway",
    destination: "https://www.betway.com",
    tag: "",
  },
  {
    slug: "10bet",
    bookmaker: "10Bet",
    destination: "https://www.10bet.com",
    tag: "",
  },
  {
    slug: "betuk",
    bookmaker: "BetUK",
    destination: "https://www.betuk.com",
    tag: "",
  },
  {
    slug: "betzone",
    bookmaker: "BetZone",
    destination: "https://www.betzone.co.uk",
    tag: "",
  },
  {
    slug: "kwiff",
    bookmaker: "Kwiff",
    destination: "https://www.kwiff.com",
    tag: "",
  },
  {
    slug: "netbet",
    bookmaker: "NetBet",
    destination: "https://www.netbet.co.uk",
    tag: "",
  },
  {
    slug: "luckster",
    bookmaker: "Luckster",
    destination: "https://www.luckster.com",
    tag: "",
  },
  {
    slug: "copybet",
    bookmaker: "CopyBet",
    destination: "https://www.copybet.com",
    tag: "",
  },
  {
    slug: "hollywood-bets",
    bookmaker: "Hollywood Bets",
    destination: "https://www.hollywoodbets.co.uk",
    tag: "",
  },
  {
    slug: "vbet",
    bookmaker: "VBet",
    destination: "https://www.vbet.co.uk",
    tag: "",
  },
  {
    slug: "mr-green",
    bookmaker: "Mr Green",
    destination: "https://www.mrgreen.com",
    tag: "",
  },
  {
    slug: "casumo",
    bookmaker: "Casumo",
    destination: "https://www.casumo.com",
    tag: "",
  },
  {
    slug: "leovegas-sport",
    bookmaker: "LeoVegas Sport",
    destination: "https://www.leovegas.com",
    tag: "",
  },
  {
    slug: "livescore-bet",
    bookmaker: "LiveScore Bet",
    destination: "https://www.livescorebet.com",
    tag: "",
  },
  {
    slug: "betmgm",
    bookmaker: "BetMGM",
    destination: "https://www.betmgm.com",
    tag: "",
  },
  {
    slug: "fitzdares",
    bookmaker: "Fitzdares",
    destination: "https://www.fitzdares.com",
    tag: "",
  },
  {
    slug: "virgin-bet",
    bookmaker: "Virgin Bet",
    destination: "https://www.virginbet.com",
    tag: "",
  },
  {
    slug: "bwin",
    bookmaker: "Bwin",
    destination: "https://www.bwin.com",
    tag: "",
  },
  {
    slug: "sportingbet",
    bookmaker: "Sportingbet",
    destination: "https://www.sportingbet.com",
    tag: "",
  },
  {
    slug: "betsson",
    bookmaker: "Betsson",
    destination: "https://www.betsson.com",
    tag: "",
  },
  {
    slug: "quinnbet",
    bookmaker: "QuinnBet",
    destination: "https://www.quinnbet.com",
    tag: "",
  },
  {
    slug: "matchbook",
    bookmaker: "Matchbook",
    destination: "https://www.matchbook.com",
    tag: "",
  },
  {
    slug: "dafabet",
    bookmaker: "Dafabet",
    destination: "https://www.dafabet.com",
    tag: "",
  },
  {
    slug: "sportpesa",
    bookmaker: "SportPesa",
    destination: "https://www.sportpesa.com",
    tag: "",
  },
  {
    // ⚠️ THE OWNER'S OWN REFERRAL LINK, not an affiliate-network tag.
    //
    // The owner gave us this link on 2026-11-04: mrq.com/invited/<code> is MrQ's
    // refer-a-friend address, and the owner is the referrer. If a visitor signs
    // up through it and qualifies, MrQ rewards the owner. That is a material
    // interest, so `referral: true` makes the plain-English disclosure render
    // wherever operator links do (see `referralDisclosure`) — it must never be
    // quietly added. `tag` stays "" because this is not a paid affiliate
    // arrangement and no tracking parameter is appended: the destination is
    // already the referral address, byte for byte.
    slug: "mrq",
    bookmaker: "MrQ",
    destination: "https://mrq.com/invited/bikehuta9?src=popup",
    tag: "",
    referral: true,
  },
];

/** Look a brand up by its public slug (case-insensitive). */
export function brandBySlug(slug: string): AffiliateBrand | undefined {
  const wanted = slug.trim().toLowerCase();
  if (!wanted) return undefined;
  return BRANDS.find((b) => b.slug === wanted);
}

/** Look a brand up by the exact bookmaker name used in the offers dataset. */
export function brandByBookmaker(bookmaker: string): AffiliateBrand | undefined {
  const wanted = bookmaker.trim().toLowerCase();
  if (!wanted) return undefined;
  return BRANDS.find((b) => b.bookmaker.trim().toLowerCase() === wanted);
}

/**
 * The tracked address for an operator link: `/go/<slug>`.
 *
 * Returns null when the brand is not registered, so a caller can fall back to the
 * plain URL instead of inventing a slug that would 404.
 */
export function goPath(bookmaker: string): string | null {
  const brand = brandByBookmaker(bookmaker);
  return brand ? `/go/${brand.slug}` : null;
}

/** `goPath()` with a fallback, for rendering an href. */
export function goHref(bookmaker: string, fallback: string): string {
  return goPath(bookmaker) ?? fallback;
}

/**
 * Where a click on `slug` actually lands.
 *
 * While no tag exists this is the destination untouched — byte for byte, with no
 * parameter added. A tag, once configured, is appended to whatever query string
 * the destination already has.
 */
export function taggedDestination(brand: AffiliateBrand): string {
  const tag = brand.tag.trim().replace(/^[?&]+/, "");
  if (!tag) return brand.destination;
  const base = brand.destination;
  const sep = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?";
  return `${base}${sep}${tag}`;
}

/** True once at least one brand has a real affiliate tag configured. */
export function hasAffiliateTags(): boolean {
  return BRANDS.some((b) => b.tag.trim().length > 0);
}

/**
 * The commission disclosure, or null while it would be untrue.
 *
 * Nothing renders it today: we are paid by nobody, so claiming we are paid would
 * be a false statement about money. It turns itself on the day a tag is set.
 */
export function commissionDisclosure(): string | null {
  if (!hasAffiliateTags()) return null;
  return (
    "Some links on this page are affiliate links: if you open a bookmaker account through one and bet with them, " +
    "that bookmaker may pay us a commission. It costs you nothing extra and it never changes the odds we show, " +
    "which price we call the best, or the order anything is listed in."
  );
}

/** Every brand whose link is the owner's own referral link. */
export function referralBrands(): readonly AffiliateBrand[] {
  return BRANDS.filter((b) => b.referral === true);
}

/** True when the link for `bookmaker` is the owner's own referral link. */
export function isReferralBrand(bookmaker: string): boolean {
  const brand = brandByBookmaker(bookmaker);
  return brand?.referral === true;
}

/** True once at least one operator link is the owner's own referral link. */
export function hasReferralLinks(): boolean {
  return referralBrands().length > 0;
}

/**
 * The referral disclosure, or null when there is no referral link to disclose.
 *
 * A referral link is the owner's own commercial interest: the visitor is owed a
 * plain statement of it, in the same breath as the link. It is written from the
 * register rather than typed into a component, so it cannot drift out of step
 * with what the links actually do — add a second referral and the sentence says
 * two, remove the last one and it disappears.
 */
export function referralDisclosure(): string | null {
  const brands = referralBrands();
  if (brands.length === 0) return null;
  const names = brands.map((b) => b.bookmaker);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const opener =
    names.length === 1
      ? `One link on this site — ${list} — is the owner's own referral link.`
      : `${names.length} links on this site are the owner's own referral links: ${list}.`;
  return (
    `${opener} If you sign up through ${names.length === 1 ? "it" : "one"}, ${list} may reward us, and the owner ` +
    "keeps that reward personally. It costs you nothing extra, and it never changes the odds we show, which price " +
    "we call the best, or the order anything is listed in." +
    (hasAffiliateTags() ? "" : " No other link on this site carries a referral or affiliate tag today.")
  );
}

/**
 * The short note printed on a row whose operator link is a referral link — the
 * disclosure has to sit with the link, not only in a footnote.
 */
export function referralRowNote(bookmaker: string): string | null {
  const brand = brandByBookmaker(bookmaker);
  if (!brand?.referral) return null;
  return `Owner's referral link — if you sign up to ${brand.bookmaker} through it, the owner may be rewarded. It does not change the odds or prices we show.`;
}
