/**
 * The one page shell every page uses: top nav + page head + content container.
 *
 * WHY IT EXISTS (owner, 2026-11-04: "the whole thing just needs to be a bit more
 * in line with the other areas" / "each subcategory feeling familiar with one
 * another"). Each page had its own nav, its own max-width and its own heading
 * rhythm, so every section read as a different site. Pages rendering the same
 * component cannot drift apart again.
 *
 * THE SURFACE (owner, 2026-11-05: pages "don't feel familiar"). This shell used
 * to carry `.page-bg`: a dark Unsplash stadium photo behind every page with a
 * 12px blur and a 30% black scrim. Body copy is `text-gray-900`, so on those
 * pages dark text sat on a dark photograph. /oddsmatcher never had it, which is
 * exactly the page the owner called right. Every page now sits on the same plain
 * surface — white, or gray-950 in dark mode — and nothing here paints an image
 * behind text. A dark band is allowed only as a *local* section with its own
 * white text (see `hero`).
 *
 * MOBILE NOTES (360px is the target):
 *  - the wordmark is hidden below `sm` — badge + the nav link is what fits
 *    without side-scroll; the EAW badge still carries the identity.
 *  - `px-4` on phones (not px-6) keeps 328px of usable width instead of 312.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface PageHeaderProps {
  /** Page title. Omitted only by Home, whose `hero` carries its own <h1>. */
  title?: string;
  subtitle?: ReactNode;
  /** Small grey fine print that belongs with the title (optional). */
  note?: ReactNode;
  /**
   * A full-bleed band rendered directly under the nav, above the title block.
   * Home's hero is the only user: it must supply its own dark background AND its
   * own light text, and must never sit behind body copy.
   */
  hero?: ReactNode;
  /** Render the site's primary links instead of "Back to Home" (Home only). */
  home?: boolean;
  /** Render children with no container wrapper, so sections can be full-bleed. */
  flush?: boolean;
  children?: ReactNode;
}

export default function PageHeader({
  title,
  subtitle,
  note,
  hero,
  home = false,
  flush = false,
  children,
}: PageHeaderProps) {
  return (
    <div className="min-h-dvh bg-white font-['Inter',system-ui,sans-serif] text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
            <span className="hidden truncate text-xl font-bold tracking-tight sm:inline">
              Everyone's A Winner
            </span>
          </Link>
          {home ? (
            <div className="flex shrink-0 items-center gap-3">
              <Link
                to="/free-bets"
                className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              >
                Free bets
              </Link>
              <Link
                to="/oddsmatcher"
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                Best odds
              </Link>
            </div>
          ) : (
            <Link
              to="/"
              className="shrink-0 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              ← Back to Home
            </Link>
          )}
        </div>
      </nav>

      {hero}

      {flush ? (
        <>
          {title ? (
            <div className="mx-auto max-w-5xl px-4 pt-8 sm:px-6">
              <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
              {subtitle ? <p className="mt-2 text-gray-600 dark:text-gray-400">{subtitle}</p> : null}
            </div>
          ) : null}
          {children}
        </>
      ) : (
        <div className="mx-auto max-w-5xl px-4 py-8 pb-12 sm:px-6">
          {title ? <h1 className="text-3xl font-bold tracking-tight">{title}</h1> : null}
          {subtitle ? <p className="mt-2 text-gray-600 dark:text-gray-400">{subtitle}</p> : null}
          {note ? <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{note}</p> : null}
          {children}
        </div>
      )}
    </div>
  );
}
