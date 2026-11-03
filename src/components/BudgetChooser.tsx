/**
 * THE ONE-TIME BUDGET CHOOSER — the dialog.
 *
 * Asks one question on the landing page ("roughly how much can you start with"),
 * then points the visitor at the route that suits that amount. The rules it
 * obeys live in src/lib/budget-chooser.ts (pure, tested); this file is only the
 * presentation and the focus handling.
 *
 * WHAT IT MUST NOT DO:
 *  - Block `/free-bets`. The question is only ever asked on `/` (BUDGET_ASK_PATH),
 *    so a visitor signing in and landing on the offers page never meets it.
 *  - Ask twice. Answering OR dismissing writes one string to localStorage, and
 *    `shouldAskForBudget` returns false from then on.
 *  - Send anyone to the server. There is no fetch here at all: the answer is a
 *    string in this visitor's browser and nowhere else.
 *  - Move the page. The overlay is `fixed`, the dialog is out of flow, and the
 *    scroll lock is padded by the scrollbar width so nothing shifts sideways
 *    when the body stops scrolling.
 *
 * ACCESSIBILITY: role="dialog" aria-modal, labelled by the question, Escape
 * dismisses, focus moves into the dialog when it opens and is returned to where
 * it came from when it closes, Tab cycles inside it, and the backdrop click
 * dismisses. 360px is the target width; every tap target is at least 44px.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isProPlan, useAuth } from "../lib/auth";
import {
  BUDGET_STORAGE_KEY,
  routeForBudget,
  shouldAskForBudget,
  type BudgetChoice,
} from "../lib/budget-chooser";

type Phase = "closed" | "ask" | "recommend";

/** Read the stored answer. Private mode can throw — treat that as "not answered". */
function readStored(): string | null {
  try {
    return localStorage.getItem(BUDGET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Remember the answer (or the dismissal). Never throws, never retried loudly. */
function writeStored(value: BudgetChoice | "dismissed"): void {
  try {
    localStorage.setItem(BUDGET_STORAGE_KEY, value);
  } catch {
    /* localStorage can throw in private mode — the dialog still routes them once */
  }
}

export default function BudgetChooser() {
  const { user, sessionStatus } = useAuth();
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>("closed");
  const [choice, setChoice] = useState<BudgetChoice | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);
  const ctaRef = useRef<HTMLAnchorElement | null>(null);
  /** The element that had focus before we opened, so it can be handed back. */
  const restoreRef = useRef<HTMLElement | null>(null);
  /** True once the question has been shown this page-load; it never reopens. */
  const askedRef = useRef(false);

  // Decide whether to ask. Waits for the server's verdict on the account first:
  // showing the £150+ answer before we know whether they have Pro would mean
  // recommending a tool that then turns them away.
  useEffect(() => {
    if (askedRef.current) return;
    if (sessionStatus === "checking") return;
    if (!shouldAskForBudget(location.pathname, readStored())) return;
    askedRef.current = true;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPhase("ask");
  }, [location.pathname, sessionStatus]);

  const close = useCallback((remember: BudgetChoice | "dismissed") => {
    writeStored(remember);
    setPhase("closed");
    setChoice(null);
    const back = restoreRef.current;
    restoreRef.current = null;
    if (back && back.isConnected) back.focus();
  }, []);

  // Scroll lock + Escape + focus trap, for as long as the dialog is open.
  // Keyed on `open` (not on `phase`) so moving from the question to the answer
  // does not unlock and relock the page, which would flash a scrollbar.
  const open = phase !== "closed";
  useEffect(() => {
    if (!open) return;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPadding = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close("dismissed");
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
    };
  }, [open, close]);

  // Move focus in: the first answer, then the recommendation's primary action.
  useEffect(() => {
    if (phase === "ask") firstButtonRef.current?.focus();
    if (phase === "recommend") ctaRef.current?.focus();
  }, [phase]);

  if (phase === "closed") return null;

  const canUseLayFinder = Boolean(user?.entitled && isProPlan(user?.plan));

  const answer = (value: BudgetChoice) => {
    writeStored(value);
    setChoice(value);
    setPhase("recommend");
  };

  const route = choice ? routeForBudget(choice, canUseLayFinder) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6">
      {/* Backdrop. A button so a click dismisses it, and Escape works from anywhere. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => close("dismissed")}
        className="absolute inset-0 h-full w-full cursor-default bg-gray-900/50 backdrop-blur-[1px] dark:bg-black/60"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="budget-chooser-title"
        aria-describedby="budget-chooser-why"
        className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-900 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="budget-chooser-title" className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {route ? route.headline : "Roughly how much can you start with?"}
          </h2>
          <button
            type="button"
            onClick={() => close("dismissed")}
            aria-label="Skip this question"
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            ×
          </button>
        </div>

        {!route && (
          <>
            <p id="budget-chooser-why" className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              Lay betting holds cash on the exchange as liability until the bet settles, so it needs a bigger
              balance behind it. Free bets across bookmakers do not tie up liability at all. That is why the
              amount you can start with changes where you should begin.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                ref={firstButtonRef}
                type="button"
                onClick={() => answer("under150")}
                className="min-h-11 w-full rounded-xl border border-gray-300 px-4 py-3 text-left text-sm font-semibold text-gray-900 hover:border-indigo-400 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:text-gray-100 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/40"
              >
                Under £150
                <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">
                  Free bets across several bookmakers
                </span>
              </button>
              <button
                type="button"
                onClick={() => answer("150plus")}
                className="min-h-11 w-full rounded-xl border border-gray-300 px-4 py-3 text-left text-sm font-semibold text-gray-900 hover:border-indigo-400 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:text-gray-100 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/40"
              >
                £150 or more
                <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">
                  Lay betting first
                </span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => close("dismissed")}
              className="mt-3 min-h-11 w-full rounded-xl px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Skip this
            </button>
          </>
        )}

        {route && (
          <>
            <p id="budget-chooser-why" className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              {route.body}
            </p>
            <Link
              ref={ctaRef}
              to={route.href}
              onClick={() => close(choice ?? "dismissed")}
              className="mt-4 flex min-h-11 w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-center text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              {route.cta}
            </Link>
            {route.secondary && (
              <Link
                to={route.secondary.href}
                onClick={() => close(choice ?? "dismissed")}
                className="mt-1 flex min-h-11 w-full items-center justify-center rounded-xl px-4 py-2 text-sm font-medium text-gray-600 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:text-indigo-400"
              >
                {route.secondary.label}
              </Link>
            )}
            <button
              type="button"
              onClick={() => close("dismissed")}
              className="mt-1 min-h-11 w-full rounded-xl px-4 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
