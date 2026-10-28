/**
 * One source of truth for how an offer row is described.
 *
 * Both the /free-bets page and the offers panel on /oddsmatcher read
 * `content/free-bets-offers.json` and use these helpers, so the paid page and
 * the public page cannot say different things about the same bookmaker.
 *
 * The important rule lives in `licenceEvidence`: a UK tick is only allowed when
 * the row itself carries the licensee and its Gambling Commission register
 * account. The pruned dataset stores the licensee and register account on every
 * kept row, so the tick and the licence line render from the row itself — never
 * from a list kept in code.
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
  // Licence evidence, as agreed with the researcher. `licenceStatus` is only
  // ever "verified" or "unverified": "unverified" means we could not re-confirm
  // it, NOT that the operator is unlicensed.
  licenceStatus?: "verified" | "unverified" | (string & {});
  licenceCheckedOn?: string;
  registerUrl?: string;
}

export interface LicenceEvidence {
  ok: boolean;
  licensee?: string;
  registerAccount?: string;
  registerUrl?: string;
  checkedOn?: string;
  status?: string;
}

/**
 * A tick needs the evidence on the row itself, not a promise in a doc.
 *
 * Absence must read as "we don't know": a row without `licenceStatus:
 * "verified"` plus a licensee and a register account earns no tick and no
 * licence line — never an assertion that the operator is unlicensed.
 */
export function licenceEvidence(o: {
  licensed?: boolean | string;
  licensee?: string;
  registerAccount?: string;
  licenceStatus?: string;
  licenceCheckedOn?: string;
  registerUrl?: string;
}): LicenceEvidence {
  const licensee = (o.licensee || "").trim();
  const registerAccount = (o.registerAccount || "").trim();
  const status = (o.licenceStatus || "").trim() || undefined;
  // `licenceStatus` is the agreed field; `licensed` is a legacy boolean that is
  // no longer read. Nothing short of an explicit "verified" earns the tick.
  const verified = status === "verified"; // a missing licenceStatus is NOT verified
  return {
    ok: verified && Boolean(licensee) && Boolean(registerAccount),
    licensee: licensee || undefined,
    registerAccount: registerAccount || undefined,
    registerUrl: (o.registerUrl || "").trim() || undefined,
    checkedOn: (o.licenceCheckedOn || "").trim() || undefined,
    status,
  };
}

/** The licence sentence for a row. Verified rows name the evidence; the rest say we do not know. */
export function licenceLine(o: Parameters<typeof licenceEvidence>[0]): string {
  const e = licenceEvidence(o);
  if (e.ok) {
    const when = e.checkedOn ? ` — checked ${e.checkedOn}` : "";
    return `Licensed by the Gambling Commission: ${e.licensee}, account ${e.registerAccount}${when}`;
  }
  return "Licence not recorded — we could not check the Gambling Commission register for this operator, so we make no claim either way";
}

/**
 * How a minimum-odds value is printed.
 *
 * Some rows carry a real figure ("1.50"); some carry prose because the
 * operator's page states none ("Not stated on the offer page"). Printing the
 * prose behind an "@" produced "Min stake £10 @ Not stated on the offer page",
 * which reads as broken. A figure keeps its "@"; prose becomes a sentence.
 */
export function minOddsLabel(value: string | undefined): { text: string; isFigure: boolean } {
  const v = (value || "").trim();
  if (/^\d/.test(v)) return { text: `@ ${v}`, isFigure: true };
  if (!v) return { text: "minimum odds not stated", isFigure: false };
  const prose = /not stated|unknown|n\/a/i.test(v) ? "minimum odds not stated" : v.charAt(0).toLowerCase() + v.slice(1);
  return { text: prose, isFigure: false };
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
