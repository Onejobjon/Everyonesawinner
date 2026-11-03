import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import PageHeader from "../components/PageHeader";
import Paywall from "../components/Paywall";
import InstantWins from "../components/InstantWins";

export default function Dashboard() {
  const { user, logout } = useAuth();

  return (
    <Paywall title="the dashboard">
      <PageHeader title="Dashboard" subtitle={`Welcome back, ${user?.name || "there"}!`}>
        <div className="flex justify-end">
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300">✅ Active</span>
        </div>

          {/* INSTANT WINS — the pre-loaded same-day feed. Top of the page because
              the whole point is that it is already there when you arrive. Paid
              tier (any plan), not Pro-only: the old pre-loaded list never was. */}
          <InstantWins />

          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
              <span className="text-2xl">📊</span>
              <h3 className="mt-4 text-lg font-semibold">Best Odds Finder</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Find and compare the best odds across UK bookmakers.</p>
              <Link to="/oddsmatcher" className="mt-4 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open →</Link>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
              <span className="text-2xl">💰</span>
              <h3 className="mt-4 text-lg font-semibold">Profit Calculator</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Calculate stakes and the profit you lock in, instantly.</p>
              <Link to="/calculator" className="mt-4 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open →</Link>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
              <span className="text-2xl">⚡</span>
              <h3 className="mt-4 text-lg font-semibold">Lay Bet Finder</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Close lays — bookmaker odds vs exchange lay odds.</p>
              <Link to="/lay-bets" className="mt-4 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open →</Link>
            </div>
          </div>

          <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <h3 className="text-lg font-semibold">Account</h3>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Email</span><span>{user?.email}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Name</span><span>{user?.name}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Plan</span><span className="font-semibold text-green-600">{user?.plan === "pro" ? "Pro" : user?.plan === "annual" ? "Pro Annual" : "Starter"}</span></div>
              {/* A free-access grant: say when it ends, so a comped user is never
                  surprised and never shown a price they do not owe. */}
              {user?.comp ? (
                <div className="flex justify-between">
                  <span className="text-gray-500">Free access</span>
                  <span>
                    {user.comp.permanent || !user.comp.endsAt
                      ? "no end date"
                      : `until ${new Date(user.comp.endsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* OWNER ONLY: the free-access grant panel. Shown on the owner's own
              seat so he does not need to remember a web address. */}
          {user?.owner ? (
            <div className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950">
              <p className="text-sm text-indigo-900 dark:text-indigo-200">
                Want a friend to try the site for free?{" "}
                <Link to="/owner/comps" className="font-semibold underline hover:text-indigo-700 dark:hover:text-indigo-100">
                  Give someone free access →
                </Link>
              </p>
            </div>
          ) : null}

          <div className="mt-6 text-center">
            <Link to="/logout" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Sign out</Link>
          </div>
      </PageHeader>
    </Paywall>
  );
}