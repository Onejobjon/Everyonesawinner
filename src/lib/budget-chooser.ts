/**
 * THE ONE-TIME BUDGET CHOOSER — which route a new visitor should start on.
 *
 * Owner request (2026-11-03): "we should have a pop up that asks the users
 * budget. If they have over £100, they should start with lay bets immediately,
 * if less than the multiple Bookmaker option is more suited." He then raised the
 * line to £150, so the split here is £150 — do not lower it back to £100.
 *
 * WHY THE SPLIT IS ABOUT CASH, NOT ABOUT SKILL:
 *  - Lay betting needs money parked on an exchange as liability. A £20 lay at
 *    odds of 5 stakes £80 of liability that you cannot spend elsewhere while the
 *    bet is open, so a small balance runs out of headroom after one or two bets.
 *  - Free bets across several bookmakers do not tie up liability at all. Each
 *    offer needs only its qualifying stake, so a small starting balance goes
 *    further spread across bookmakers than concentrated on one exchange.
 * That is the whole reason for asking, and it is what the copy says.
 *
 * PRIVACY: the answer never leaves the browser. It is not sent to the server, it
 * is not in any request, and there is no analytics. It is one string in this
 * visitor's own localStorage, the same way the commission rate is kept.
 *
 * PURE MODULE: no React, no DOM. The dialog (src/components/BudgetChooser.tsx)
 * is presentation; everything decidable is here so it can be tested without a
 * browser.
 */

/** What the visitor said, or that they closed the question unanswered. */
export type BudgetAnswer = "under150" | "150plus" | "dismissed";

/** The two answers that lead somewhere. `dismissed` leads nowhere. */
export type BudgetChoice = Exclude<BudgetAnswer, "dismissed">;

/** localStorage key. Versioned so an older/other shape is ignored, not guessed at. */
export const BUDGET_STORAGE_KEY = "eaw_budget_choice_v1";

/**
 * The one page the question is asked on: the landing page.
 *
 * Deliberately NOT every page. `/free-bets` is where a signed-in visitor lands
 * and it must never be blocked, and a question about your budget is a thing to
 * ask someone arriving at the front door, not someone halfway through a task.
 */
export const BUDGET_ASK_PATH = "/";

const ANSWERS: readonly BudgetAnswer[] = ["under150", "150plus", "dismissed"];

/**
 * Read a stored answer. Anything unrecognised (old value, hand-edited, another
 * site's key) counts as "not answered yet" — never as an answer we act on.
 */
export function parseBudgetAnswer(raw: string | null | undefined): BudgetAnswer | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return (ANSWERS as readonly string[]).includes(trimmed) ? (trimmed as BudgetAnswer) : null;
}

/**
 * Should the question be put to this visitor, on this page?
 *
 * True only on the landing page AND only while no answer is stored. Once it has
 * been answered — or dismissed — this returns false forever, which is what stops
 * it appearing a second time.
 */
export function shouldAskForBudget(pathname: string, raw: string | null | undefined): boolean {
  if (parseBudgetAnswer(raw) !== null) return false;
  return pathname === BUDGET_ASK_PATH;
}

/** Where an answer sends the visitor, and what the dialog says about it. */
export interface BudgetRoute {
  /** The route the primary button opens. Never a paywall for a non-entitled visitor. */
  href: string;
  /** Label on the primary button. */
  cta: string;
  /** Heading of the recommendation panel. */
  headline: string;
  /** One short paragraph: why this route, in money terms. */
  body: string;
  /** Optional quiet second link, so a route is never a dead end. */
  secondary?: { href: string; label: string };
}

/** The lay betting guide and the Lay Bet Finder both live at this one route. */
export const LAY_ROUTE = "/lay-bets";
/** The multiple-bookmaker route. */
export const FREE_BETS_ROUTE = "/free-bets";
/** What Pro includes, for a visitor who answered £150+ but is not entitled. */
export const PRO_ROUTE = "/subscribe";

/**
 * Resolve an answer into a route.
 *
 * `canUseLayFinder` must be the SERVER's verdict (GET /api/me → entitled AND a
 * Pro plan), the same one `Paywall` uses. The £150+ visitor who is not entitled
 * gets a plain explanation plus a working way forward — the free-bets route — so
 * answering "£150 or more" never dumps someone on a paywall with nothing to do.
 */
export function routeForBudget(choice: BudgetChoice, canUseLayFinder: boolean): BudgetRoute {
  if (choice === "under150") {
    return {
      href: FREE_BETS_ROUTE,
      cta: "See the free bets",
      headline: "Start with free bets across bookmakers",
      body:
        "A lay bet holds cash on the exchange as liability until the bet settles, so a smaller starting balance runs out of headroom quickly. Free bets do not: each offer needs only its qualifying stake, so your money spreads across several bookmakers instead of being tied up on one exchange.",
      secondary: { href: "/how-we-check-offers", label: "How we check each offer" },
    };
  }

  if (canUseLayFinder) {
    return {
      href: LAY_ROUTE,
      cta: "Open the Lay Bet Finder",
      headline: "Start with lay betting",
      body:
        "With £150 or more you can cover exchange liability, so you can start where the money moves faster. The Lay Bet Finder lists matches where backing at a bookmaker and laying on an exchange leaves a gap, and the lay betting guide sits on the same page.",
      secondary: { href: FREE_BETS_ROUTE, label: "Or claim free bets first" },
    };
  }

  return {
    href: FREE_BETS_ROUTE,
    cta: "Start with free bets",
    headline: "Start with free bets across bookmakers",
    body:
      "The Lay Bet Finder is a Pro tool: it lists matches where backing at a bookmaker and laying on an exchange leaves a gap, with the lay stake and liability worked out. It is not on your account yet, so the multiple-bookmaker route is the one open to you today — free bets do not tie up exchange liability, so a small balance still works.",
    secondary: { href: PRO_ROUTE, label: "See what Pro includes" },
  };
}
