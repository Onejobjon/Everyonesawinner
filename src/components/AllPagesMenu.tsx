/**
 * "ALL PAGES" DROPDOWN — lives in the shared header, so it is on every page
 * including Home (owner, 2026-11-06: "there needs to be a drop down with all the
 * pages for quick and easy navigation").
 *
 * WHY A REAL BUTTON: the trigger is a `<button>` with `aria-expanded` and
 * `aria-controls`, not a styled div, so keyboard and screen-reader users get the
 * state. Escape closes the panel AND puts focus back on the trigger; a pointer
 * press outside closes it; following an item closes it (the route change does
 * that). Every item is a react-router `<Link>` — a real `<a href>` that works
 * without JavaScript's history API.
 *
 * MOBILE (360px is the test width): the trigger is icon-only below `sm`, because
 * Home's own nav links + the EAW badge leave ~76px of the 328px usable width at
 * 360px and a text label does not fit. The panel is `100vw - 2rem` wide at most
 * (328px at 360px) and right-aligned to the trigger, so it never crosses the
 * viewport edge. Its height is capped and it scrolls, so a long list can never
 * be clipped by the sticky header or run off the bottom of a short screen.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { NAV_GROUPS } from "./navLinks";

const PANEL_ID = "all-pages-menu";
/** The first destination in the list — where keyboard focus starts on open. */
const FIRST_ITEM = NAV_GROUPS[0].items[0].to;

export default function AllPagesMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstItemRef = useRef<HTMLAnchorElement | null>(null);
  const { pathname } = useLocation();

  // Following an item navigates; the panel must not stay open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    // Keyboard users land on the first item, so Tab walks the list.
    firstItemRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const wrap = wrapRef.current;
      if (wrap && !wrap.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label="All pages"
        onClick={() => setOpen((was) => !was)}
        className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="h-4 w-4 shrink-0"
        >
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
        <span className="hidden sm:inline">All pages</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>

      {open ? (
        <div
          id={PANEL_ID}
          aria-label="All pages"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 max-h-[min(70vh,30rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-800 dark:bg-gray-900"
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {group.label}
              </p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      ref={item.to === FIRST_ITEM ? firstItemRef : undefined}
                      to={item.to}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.pro ? (
                        <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200">
                          Pro
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
