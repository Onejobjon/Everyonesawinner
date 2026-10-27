/**
 * One source of truth for how an offer row is described.
 *
 * Both the /free-bets page and the offers panel on /oddsmatcher read
 * `content/free-bets-offers.json` and use these helpers, so the paid page and
 * the public page cannot say different things about the same bookmaker.
 *
 * The important rule lives in `licenceEvidence`: a UK tick is only allowed when
 * the row itself carries the licensee and its Gambling Commission register
 * account. The pruned dataset records the register evidence that justified
 * removing a row, but does not (yet) store it per kept row — so today no row
 * earns a tick, and both surfaces say so instead of implying a licence we
 * cannot point at.
 */
export interface FreeBetOffer {
  bookmaker: string;
  section: "uk" | "global";
  jurisdiction: string;
  offer: string;
  headlineValue: string;
  minStake: string;
  minOdds: string;
  freeBetTokens: string;
  freeBetExpiry: string;
  estProfit: string | null;
  ukGbp: string;
  keyTerms?: string[];
  notes?: string;
  url: string;
  urlVerified: boolean;
  status: "verified" | "changed" | "unverifiable" | "withdrawn" | (string & {});
  statusReason?: string;
  checked_on: string;
  verified_on?: string | null;
  estProfitStatus?: string;
  estProfitRemovedReason?: string;
  evidenceQuote?: string;
  // Licence evidence — see licenceEvidence().
  licensed?: boolean | string;
  licensee?: string;
  registerAccount?: string;
}

export interface LicenceEvidence {
  ok: boolean;
  licensee?: string;
  registerAccount?: string;
}

/** A tick needs the evidence on the row itself, not a promise in a doc. */
export function licenceEvidence(o: {
  licensed?: boolean | string;
  licensee?: string;
  registerAccount?: string;
}): LicenceEvidence {
  const licensed = o.licensed === true || o.licensed === "true";
  const licensee = (o.licensee || "").trim();
  const registerAccount = (o.registerAccount || "").trim();
  return {
    ok: licensed && Boolean(licensee) && Boolean(registerAccount),
    licensee: licensee || undefined,
    registerAccount: registerAccount || undefined,
  };
}

/** Shown wherever a profit figure used to be. */
export const NOT_QUOTED = "not quoted — depends on the odds you match at";

/**
 * A profit figure may only be shown if the row says what it is, and a labelled
 * estimate is never dressed up as a promise.
 */
export function profitText(o: FreeBetOffer): { text: string; isEstimate: boolean; basis?: string } {
  const value = typeof o.estProfit === "string" ? o.estProfit.trim() : "";
  if (!value) return { text: NOT_QUOTED, isEstimate: false };
  const basis = [o.estProfitStatus, o.estProfitRemovedReason].filter(Boolean).join(" — ") || undefined;
  return { text: `${value} (estimate)`, isEstimate: true, basis };
}

export type StatusTone = "changed" | "verified" | "unverifiable" | "withdrawn";

export function statusLabel(status: string | undefined): { tone: StatusTone; text: string } {
  switch (status) {
    case "verified":
      return { tone: "verified", text: "verified" };
    case "changed":
      return { tone: "changed", text: "re-checked — terms changed" };
    case "withdrawn":
      return { tone: "withdrawn", text: "withdrawn" };
    default:
      return { tone: "unverifiable", text: "unverified" };
  }
}

/** Only rows we are willing to show: everything except a confirmed withdrawal. */
export function keptOffers(rows: FreeBetOffer[]): FreeBetOffer[] {
  return rows.filter((o) => o.status !== "withdrawn");
}
