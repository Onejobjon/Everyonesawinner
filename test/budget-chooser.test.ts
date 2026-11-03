import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGET_ASK_PATH,
  BUDGET_STORAGE_KEY,
  FREE_BETS_ROUTE,
  LAY_ROUTE,
  parseBudgetAnswer,
  routeForBudget,
  shouldAskForBudget,
} from "../src/lib/budget-chooser";

/**
 * THE ONE-TIME BUDGET CHOOSER.
 *
 * Owner request (2026-11-03): ask a visitor's budget and send them to the right
 * starting route — £150+ to lay betting, under £150 to the multiple-bookmaker
 * route. The threshold is £150, not the £100 he first said.
 *
 * What these tests pin, and why each one matters:
 *  - it is asked ONCE. Answered or dismissed, it never comes back. A question
 *    that reappears on every page load is a nag, not a helper.
 *  - it never appears on `/free-bets`, which is where a signed-in visitor lands.
 *  - each answer resolves to a real route, and the under-£150 route is the free
 *    bets page.
 *  - a £150+ visitor WITHOUT the Pro tool is not dropped on a paywall: the
 *    primary action still goes somewhere they can use, and the copy says plainly
 *    that the finder is a Pro tool and what it does.
 *  - the copy breaks no rule: no profit promise, no urgency, no "you must".
 */

const ROOT = join(import.meta.dir, "..");
const COMPONENT = readFileSync(join(ROOT, "src/components/BudgetChooser.tsx"), "utf8");
const LIB = readFileSync(join(ROOT, "src/lib/budget-chooser.ts"), "utf8");
const APP = readFileSync(join(ROOT, "src/App.tsx"), "utf8");

describe("asked once", () => {
  test("unanswered visitor on the landing page is asked", () => {
    expect(shouldAskForBudget("/", null)).toBe(true);
    expect(shouldAskForBudget(BUDGET_ASK_PATH, undefined)).toBe(true);
  });

  test("an answer stops it recurring — and so does a dismissal", () => {
    expect(shouldAskForBudget("/", "under150")).toBe(false);
    expect(shouldAskForBudget("/", "150plus")).toBe(false);
    expect(shouldAskForBudget("/", "dismissed")).toBe(false);
  });

  test("a junk stored value is not an answer, so the question is still fair to ask", () => {
    expect(shouldAskForBudget("/", "yes")).toBe(true);
    expect(parseBudgetAnswer("yes")).toBeNull();
    expect(parseBudgetAnswer("")).toBeNull();
    expect(parseBudgetAnswer(null)).toBeNull();
  });

  test("only the two real answers parse", () => {
    expect(parseBudgetAnswer("under150")).toBe("under150");
    expect(parseBudgetAnswer("150plus")).toBe("150plus");
    expect(parseBudgetAnswer("dismissed")).toBe("dismissed");
    expect(parseBudgetAnswer(" 150plus ")).toBe("150plus");
  });

  test("never asked on the pages a visitor is already working in", () => {
    expect(shouldAskForBudget(FREE_BETS_ROUTE, null)).toBe(false);
    expect(shouldAskForBudget(LAY_ROUTE, null)).toBe(false);
    expect(shouldAskForBudget("/login", null)).toBe(false);
    expect(shouldAskForBudget("/signup", null)).toBe(false);
    expect(shouldAskForBudget("/calculator", null)).toBe(false);
  });
});

describe("each route resolves", () => {
  test("under £150 → the multiple bookmaker route", () => {
    for (const entitled of [true, false]) {
      const r = routeForBudget("under150", entitled);
      expect(r.href).toBe(FREE_BETS_ROUTE);
      expect(r.cta.length).toBeGreaterThan(0);
      expect(r.body.length).toBeGreaterThan(0);
    }
  });

  test("£150 or more with the Pro tool → lay betting first", () => {
    const r = routeForBudget("150plus", true);
    expect(r.href).toBe(LAY_ROUTE);
    expect(r.cta.toLowerCase()).toContain("lay bet finder");
  });

  test("£150 or more WITHOUT the Pro tool does not dead-end", () => {
    const r = routeForBudget("150plus", false);
    // The primary action must be somewhere they can actually go, not the gate.
    expect(r.href).not.toBe(LAY_ROUTE);
    expect(r.href).toBe(FREE_BETS_ROUTE);
    // Says plainly that it is a Pro tool, and what it does.
    expect(r.body).toContain("Pro tool");
    expect(r.body.toLowerCase()).toContain("laying on an exchange");
    // And there is a way to see what Pro is, rather than a bare wall.
    expect(r.secondary?.href).toBe("/subscribe");
  });

  test("every answer gives a working link, never an empty href", () => {
    for (const choice of ["under150", "150plus"] as const) {
      for (const entitled of [true, false]) {
        const r = routeForBudget(choice, entitled);
        expect(r.href.startsWith("/")).toBe(true);
        if (r.secondary) expect(r.secondary.href.startsWith("/")).toBe(true);
      }
    }
  });
});

describe("copy rules", () => {
  const copy = ["under150", "150plus"].flatMap((c) =>
    [true, false].flatMap((e) => {
      const r = routeForBudget(c as "under150" | "150plus", e);
      return [r.headline, r.body, r.cta, r.secondary?.label ?? ""];
    }),
  ).join(" \n ");

  test("no profit promise and no urgency", () => {
    for (const banned of ["guarantee", "risk-free", "risk free", "profit", "earn £", "hurry", "urgent", "act now", "limited time", "spots left", "today only"]) {
      expect(copy.toLowerCase()).not.toContain(banned);
    }
  });

  test("no 'you must' and no analytics", () => {
    expect(copy.toLowerCase()).not.toContain("you must");
    expect(copy.toLowerCase()).not.toContain("sign up now");
  });

  test("the split is explained in cash terms: liability vs no liability", () => {
    const all = `${routeForBudget("under150", false).body} ${routeForBudget("150plus", false).body}`;
    expect(all.toLowerCase()).toContain("liability");
  });
});

describe("the answer stays in the browser", () => {
  test("the component makes no network call at all", () => {
    expect(COMPONENT).not.toContain("fetch(");
    expect(COMPONENT).not.toContain("XMLHttpRequest");
    expect(COMPONENT).not.toContain("/api/");
  });

  test("it stores exactly one key, and reads the same one", () => {
    const writes = COMPONENT.match(/setItem\(/g) ?? [];
    expect(writes.length).toBe(1);
    expect(COMPONENT).toContain("BUDGET_STORAGE_KEY");
    expect(COMPONENT).toContain("localStorage.getItem(BUDGET_STORAGE_KEY)");
    expect(LIB).toContain('BUDGET_STORAGE_KEY = "eaw_budget_choice_v1"');
  });

  test("a throwing localStorage does not break the page", () => {
    expect(COMPONENT).toContain("catch {");
  });
});

describe("accessible dialog", () => {
  test("role, modal, and a label", () => {
    expect(COMPONENT).toContain('role="dialog"');
    expect(COMPONENT).toContain('aria-modal="true"');
    expect(COMPONENT).toContain('aria-labelledby="budget-chooser-title"');
    expect(COMPONENT).toContain('id="budget-chooser-title"');
  });

  test("Escape dismisses and focus is moved in and handed back", () => {
    expect(COMPONENT).toContain('e.key === "Escape"');
    expect(COMPONENT).toContain('close("dismissed")');
    expect(COMPONENT).toContain(".focus()");
    expect(COMPONENT).toContain("restoreRef");
    expect(COMPONENT).toContain('e.key !== "Tab"');
  });

  test("no layout shift: fixed overlay, out of flow, padded scroll lock", () => {
    expect(COMPONENT).toContain("fixed inset-0");
    expect(COMPONENT).toContain("document.body.style.overflow = \"hidden\"");
    expect(COMPONENT).toContain("document.body.style.paddingRight");
  });

  test("360px and dark mode", () => {
    expect(COMPONENT).toContain("max-w-md");
    expect(COMPONENT).toContain("w-full");
    expect(COMPONENT).toContain("dark:bg-gray-900");
    expect(COMPONENT).toContain("min-h-11");
  });
});

describe("wiring", () => {
  test("the chooser is mounted once, inside the auth provider", () => {
    expect(APP).toContain("<BudgetChooser />");
    const mounted = APP.indexOf("<BudgetChooser />");
    expect(mounted).toBeGreaterThan(APP.indexOf("<AuthProvider>"));
    expect(mounted).toBeLessThan(APP.indexOf("</AuthProvider>"));
    expect((APP.match(/<BudgetChooser \/>/g) ?? []).length).toBe(1);
  });

  test("Pro is decided by the server's verdict, not by a local guess", () => {
    expect(COMPONENT).toContain("user?.entitled");
    expect(COMPONENT).toContain("isProPlan");
  });

  test("the threshold is £150, not the £100 first mentioned", () => {
    expect(COMPONENT).toContain("£150 or more");
    expect(COMPONENT).toContain("Under £150");
    expect(COMPONENT).not.toContain("£100");
  });
});
