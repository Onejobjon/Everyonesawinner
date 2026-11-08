/**
 * EVERY PAGE, IN ONE PLACE (owner, 2026-11-06: "there needs to be a drop down
 * with all the pages for quick and easy navigation").
 *
 * The list lives here rather than inside the header component so it can be
 * tested against the router: `test/nav-menu.test.ts` reads every `<Route>` in
 * `App.tsx` and fails if a page is missing from this list, or if this list
 * points at a route that does not exist. A page added to the router without a
 * menu entry is therefore a failing test, not a page nobody can find.
 *
 * Labels are the names the pages already use on screen. `pro: true` adds the
 * "Pro" chip — those three routes are gated server-side by the Pro plan; the
 * chip is a label, never the gate.
 */
export interface NavItem {
  to: string;
  label: string;
  /** Pro-only page: render a "Pro" chip beside the label. */
  pro?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Start here",
    items: [
      { to: "/", label: "Home" },
      { to: "/free-bets", label: "Free bets" },
      { to: "/how-we-check-offers", label: "How we check offers" },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/oddsmatcher", label: "Oddsmatcher" },
      { to: "/calculator", label: "Calculator" },
      { to: "/dashboard", label: "Dashboard" },
      { to: "/lay-bets", label: "Lay Bet Finder", pro: true },
      { to: "/bet-builder", label: "Bet Builder", pro: true },
      { to: "/same-match", label: "Same-Match Planner", pro: true },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/account", label: "Your account" },
      { to: "/signup", label: "Sign up" },
      { to: "/login", label: "Sign in" },
      { to: "/logout", label: "Sign out" },
      { to: "/subscribe", label: "Pricing" },
    ],
  },
  {
    label: "Legal",
    items: [
      { to: "/privacy", label: "Privacy" },
      { to: "/terms", label: "Terms" },
    ],
  },
];

/** Flat list of every menu destination — handy for tests and for `/` checks. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
