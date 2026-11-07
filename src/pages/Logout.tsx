import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../lib/auth";

/**
 * /logout — a REAL signed-out state (defect fix, 2026-11-07).
 *
 * WHAT WAS WRONG. This page called logout() and then immediately
 * `navigate("/", { replace: true })`. The visitor never saw a confirmation: the
 * spinner below existed for at most one frame, and then the marketing home page
 * appeared — on the live site with the first-visit budget chooser modal over it.
 * Nothing on that screen says "you are signed out", so a person who clicked
 * "Sign out" cannot tell whether it worked, and somebody who was signed in on a
 * shared computer has no confirmation that they are out.
 *
 * WHAT IT DOES NOW. It stays on /logout and says plainly what happened. The
 * session is still revoked on the server (auth.logout() POSTs /api/logout), so
 * this is a report of a real state, not a cosmetic one. There is no auto-redirect:
 * the way onward is a link the visitor chooses.
 */
export default function Logout() {
  const { logout } = useAuth();
  // Read the saved sign-in SYNCHRONOUSLY, before logout() removes it, so the page
  // can tell "you have just been signed out" from "you were not signed in on this
  // device". Reading localStorage rather than the auth context also covers a
  // direct load of /logout, where the context is still resolving /api/me.
  const [hadSession] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem("eaw_session"));
    } catch {
      return false;
    }
  });
  const ran = useRef(false);

  useEffect(() => {
    // React StrictMode runs effects twice in development; revoking twice is
    // harmless, but guard it so the intent is obvious.
    if (ran.current) return;
    ran.current = true;
    logout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageHeader title="You're signed out" subtitle="Your session on this device has ended.">
      <div className="mx-auto max-w-md">
        <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">You are signed out</p>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-gray-700 dark:text-gray-300">
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-emerald-600">✓</span>
              <span>
                {hadSession === false
                  ? "This browser had no saved sign-in, so there is nothing left open."
                  : "The sign-in saved in this browser has been removed."}
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-emerald-600">✓</span>
              <span>
                The session was also ended on our server, so a copied sign-in link stops working.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-emerald-600">✓</span>
              <span>
                Your account, any free access and any subscription are unchanged — nothing is cancelled
                by signing out.
              </span>
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            to="/login"
            className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-700"
          >
            Sign in again
          </Link>
          <Link
            to="/"
            className="flex-1 rounded-xl border border-gray-300 px-4 py-3 text-center text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
          >
            Back to home
          </Link>
        </div>

        <p className="mt-6 text-xs leading-5 text-gray-500 dark:text-gray-400">
          Signed out by mistake? Signing in again takes a few seconds and your plan and free access come
          back with it. Any questions:{" "}
          <a href="mailto:support@everyonesawinner.uk" className="text-indigo-600 underline hover:text-indigo-700 dark:text-indigo-400">
            support@everyonesawinner.uk
          </a>
          .
        </p>
      </div>
    </PageHeader>
  );
}
