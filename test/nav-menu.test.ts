import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_GROUPS, NAV_ITEMS } from "../src/components/navLinks";

/**
 * THE HEADER MENU MUST LIST EVERY PAGE.
 *
 * The owner asked for a dropdown with all the pages, on every page. That is only
 * true for as long as someone remembers to add each new page to the list, so the
 * list is checked against the router itself: every `<Route>` in `App.tsx` has to
 * appear in the menu, and every menu entry has to be a route that exists. Add a
 * page and forget the menu → this fails. Menu a URL that was deleted → this
 * fails too.
 *
 * Redirects are not pages: `<Route path="/world-cup" element={<Navigate …>}>`
 * sends you elsewhere, so it is excluded by looking at the element, not by a
 * hard-coded list. `/subscribe/success` is the one page deliberately left out:
 * it is the landing a payment provider returns you to, reachable only by paying,
 * and putting it in a navigation menu would invite people to click a receipt for
 * a purchase they have not made.
 */

const ROOT = join(import.meta.dir, "..");

const APP_SOURCE = readFileSync(join(ROOT, "src/App.tsx"), "utf8");

/** Every `<Route>` in the router, with its element source. */
function routesInApp(): { path: string; element: string }[] {
  const routes: { path: string; element: string }[] = [];
  const re = /<Route\s+path="([^"]+)"\s+element=\{(<[^>]+>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(APP_SOURCE)) !== null) {
    routes.push({ path: match[1], element: match[2] });
  }
  return routes;
}

/**
 * Pages that exist but are deliberately not in the menu, with the reason.
 *  - `/subscribe/success` is the landing a payment provider returns you to;
 *  - `/owner/comps` is the owner's own free-access panel (2026-11-02). It is
 *    linked from his dashboard and refused with a 404 for everyone else, so it
 *    must not appear in a menu every visitor sees.
 */
const NOT_IN_MENU = new Set<string>(["/subscribe/success", "/owner/comps"]);

describe("header All pages menu", () => {
  const routes = routesInApp();
  const pages = routes.filter((r) => !r.element.startsWith("<Navigate")).map((r) => r.path);

  test("the router was actually parsed (guard against a silently empty check)", () => {
    // 16 real pages + 3 redirects at the time of writing; a parser that matched
    // nothing would otherwise make every test below pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(pages.length).toBeGreaterThanOrEqual(12);
    expect(pages).toContain("/");
    expect(pages).toContain("/oddsmatcher");
  });

  test("every page in App.tsx is in the menu", () => {
    const listed = new Set(NAV_ITEMS.map((item) => item.to));
    const missing = pages.filter((path) => !NOT_IN_MENU.has(path) && !listed.has(path));
    expect(missing).toEqual([]);
  });

  test("every menu entry is a real route in App.tsx", () => {
    const known = new Set(routes.map((r) => r.path));
    const unknown = NAV_ITEMS.map((item) => item.to).filter((to) => !known.has(to));
    expect(unknown).toEqual([]);
  });

  test("no page is listed twice", () => {
    const seen = NAV_ITEMS.map((item) => item.to);
    expect(seen.length).toBe(new Set(seen).size);
  });

  test("the Pro pages carry the Pro chip and the free pages do not", () => {
    const pro = NAV_ITEMS.filter((item) => item.pro).map((item) => item.to).sort();
    expect(pro).toEqual(["/bet-builder", "/lay-bets", "/same-match"]);
  });

  test("the groups and their pages are the ones the owner asked for", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Start here",
      "Tools",
      "Account",
      "Legal",
    ]);
    const byGroup = Object.fromEntries(
      NAV_GROUPS.map((group) => [group.label, group.items.map((item) => item.to)]),
    );
    expect(byGroup["Start here"]).toEqual(["/", "/free-bets", "/how-we-check-offers"]);
    expect(byGroup.Tools.slice(0, 3)).toEqual(["/oddsmatcher", "/calculator", "/dashboard"]);
    expect(byGroup.Account).toContain("/subscribe");
    expect(byGroup.Legal).toEqual(["/privacy", "/terms"]);
  });

  test("labels are what the pages call themselves", () => {
    const label = (to: string) => NAV_ITEMS.find((item) => item.to === to)?.label;
    expect(label("/bet-builder")).toBe("Bet Builder");
    expect(label("/same-match")).toBe("Same-Match Planner");
    expect(label("/subscribe")).toBe("Pricing");
    expect(label("/how-we-check-offers")).toBe("How we check offers");
  });

  test("the shared header renders the menu, so it is on every page including Home", () => {
    const header = readFileSync(join(ROOT, "src/components/PageHeader.tsx"), "utf8");
    // Exactly one <AllPagesMenu />, outside the home/non-home branch's shared
    // prefix — i.e. both branches get it.
    expect(header.match(/<AllPagesMenu\s*\/>/g)?.length).toBe(2);
  });
});
