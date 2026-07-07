import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import Paywall from "../components/Paywall";

export default function Dashboard() {
  const { user, logout } = useAuth();

  return (
    <Paywall title="the dashboard">
      <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
        <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
              <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
            </Link>
            <div className="flex items-center gap-4">
              <Link to="/oddsmatcher" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Best Odds</Link>
              <Link to="/logout" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400">Sign out</Link>
            </div>
          </div>
        </nav>

        <div className="mx-auto max-w-5xl px-6 py-12">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
              <p className="mt-1 text-gray-600 dark:text-gray-400">Welcome back, {user?.name || "there"}!</p>
            </div>
            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300">✅ Active</span>
          </div>

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
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Calculate stakes and guaranteed profit instantly.</p>
              <Link to="/calculator" className="mt-4 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open →</Link>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
              <span className="text-2xl">🏆</span>
              <h3 className="mt-4 text-lg font-semibold">World Cup 2026</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">World Cup match odds with profit calculations.</p>
              <Link to="/world-cup" className="mt-4 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open →</Link>
            </div>
          </div>

          <div className="mt-8 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
            <h3 className="text-lg font-semibold">Account</h3>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Email</span><span>{user?.email}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Name</span><span>{user?.name}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Plan</span><span className="font-semibold text-green-600">Active</span></div>
            </div>
          </div>

          <div className="mt-6 text-center">
            <Link to="/logout" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Sign out</Link>
          </div>
        </div>
      </div>
    </Paywall>
  );
}