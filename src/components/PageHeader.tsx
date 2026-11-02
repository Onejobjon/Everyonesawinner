/**
 * The one page shell every tool page uses: top nav + page head + content
 * container.
 *
 * WHY IT EXISTS (owner, 2026-11-04: "the whole thing just needs to be a bit more
 * in line with the other areas" / "each subcategory feeling familiar with one
 * another"). The Lay Bet Finder had its own nav, its own max-width and its own
 * heading rhythm, so it read as a different site. Two pages rendering the same
 * component cannot drift apart again.
 *
 * MOBILE NOTES (360px is the target):
 *  - the wordmark is hidden below `sm` — badge + "Back to Home" is what fits
 *    without side-scroll; the EAW badge still carries the identity.
 *  - `px-4` on phones (not px-6) keeps 328px of usable width instead of 312.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface PageHeaderProps {
  title: string;
  subtitle: string;
  /** Small grey fine print that belongs with the title (optional). */
  note?: ReactNode;
  children?: ReactNode;
}

export default function PageHeader({ title, subtitle, note, children }: PageHeaderProps) {
  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
            <span className="hidden truncate text-xl font-bold tracking-tight sm:inline">
              Everyone's A Winner
            </span>
          </Link>
          <Link
            to="/"
            className="shrink-0 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            ← Back to Home
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">{subtitle}</p>
        {note ? <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{note}</p> : null}
        {children}
      </div>
    </div>
  );
}
