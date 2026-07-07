import { Link } from "react-router-dom";

export default function Preview() {
  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="text-center">
          <span className="text-5xl">🔍</span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight">Owner Preview</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Preview all pages — no auth or subscription required.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            to="/oddsmatcher?preview=1"
            className="rounded-xl border-2 border-gray-200 bg-white p-6 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all dark:border-gray-800 dark:bg-gray-950"
          >
            <span className="text-3xl">📊</span>
            <h3 className="mt-3 text-lg font-bold">Best Odds Finder</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Live odds across UK bookmakers with profit calculations.</p>
          </Link>

          <Link
            to="/calculator?preview=1"
            className="rounded-xl border-2 border-gray-200 bg-white p-6 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all dark:border-gray-800 dark:bg-gray-950"
          >
            <span className="text-3xl">💰</span>
            <h3 className="mt-3 text-lg font-bold">Profit Calculator</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Calculate stakes and guaranteed profit instantly.</p>
          </Link>

          <Link
            to="/world-cup?preview=1"
            className="rounded-xl border-2 border-gray-200 bg-white p-6 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all dark:border-gray-800 dark:bg-gray-950"
          >
            <span className="text-3xl">🏆</span>
            <h3 className="mt-3 text-lg font-bold">World Cup 2026</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">World Cup match odds with profit calculations.</p>
          </Link>

          <Link
            to="/dashboard?preview=1"
            className="rounded-xl border-2 border-gray-200 bg-white p-6 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all dark:border-gray-800 dark:bg-gray-950"
          >
            <span className="text-3xl">📈</span>
            <h3 className="mt-3 text-lg font-bold">Dashboard</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">User dashboard with account info and tool links.</p>
          </Link>
        </div>

        <div className="mt-12 border-t border-gray-200 dark:border-gray-800 pt-8 text-center">
          <Link to="/" className="text-sm text-indigo-600 hover:text-indigo-700">← Back to Home</Link>
        </div>
      </div>
    </div>
  );
}