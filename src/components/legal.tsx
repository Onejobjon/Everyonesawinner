import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Shared furniture for the two legal pages (/privacy and /terms).
 *
 * Same type scale, spacing and dark-mode treatment as HowWeCheckOffers, so the
 * legal pages do not look like a different site. Nothing here decides wording —
 * each page supplies its own sections.
 *
 * Both pages must be readable without logging in: they live in the public part
 * of the router next to /free-bets and /how-we-check-offers.
 */

/** The line both legal pages carry at the top, verbatim. */
export const PLAIN_ENGLISH_LINE =
  "This is a plain-English notice, not legal advice. We recommend a solicitor reviews it before launch.";

export function LegalLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950">
      <section className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          {title}
        </h1>
        <div className="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">
            <strong className="font-semibold">Plain English, not a legal document.</strong>{" "}
            {PLAIN_ENGLISH_LINE}
          </p>
        </div>
        {children}
        <p className="mt-10 border-t border-gray-200 pt-6 text-xs text-gray-400 dark:border-gray-800">
          18+ · begambleaware.org ·{" "}
          <Link to="/privacy" className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link to="/terms" className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
            Terms
          </Link>{" "}
          ·{" "}
          <Link to="/free-bets" className="underline hover:text-indigo-600 dark:hover:text-indigo-400">
            the offers we list
          </Link>
        </p>
      </section>
    </div>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-8 mb-3 text-xl font-semibold text-gray-900 dark:text-gray-100">
      {children}
    </h2>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 text-sm leading-6 text-gray-600 dark:text-gray-400">{children}</p>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mb-4 ml-5 list-disc space-y-2 text-sm leading-6 text-gray-600 dark:text-gray-400">
      {children}
    </ul>
  );
}

/** A clearly-marked gap in the copy, so nobody mistakes it for final. */
export function PlaceholderNote({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs italic text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {children}
    </p>
  );
}

/** Inline link that leaves the site. */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:text-indigo-600 dark:hover:text-indigo-400"
    >
      {children}
    </a>
  );
}
