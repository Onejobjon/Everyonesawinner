import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const [dashData, setDashData] = useState<{
    totalProfit: number;
    completedOffers: number;
    activeOffers: any[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // Check for auth cookie on client side
    const hasCookie = document.cookie.includes("mp_token=");
    if (!hasCookie) {
      window.location.href = "/login";
      return;
    }

    // Load from localStorage for demo purposes
    const stored = localStorage.getItem("mp_dashboard");
    if (stored) {
      try {
        setDashData(JSON.parse(stored));
      } catch { /* ignore */ }
    } else {
      setDashData({ totalProfit: 0, completedOffers: 0, activeOffers: [] });
    }
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <Layout>
        <div className="text-center py-16 animate-pulse text-gray-400">Loading dashboard...</div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="text-center py-16">
          <p className="text-red-600">{error}</p>
          <Link href="/login" className="mt-4 inline-block text-indigo-600 font-semibold">Log in</Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Your Dashboard</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">Track your matched betting profits and offers.</p>

        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm font-medium text-gray-500">Total Profit</p>
            <p className="mt-2 text-3xl font-extrabold text-green-600">
              £{dashData?.totalProfit.toFixed(2) || "0.00"}
            </p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm font-medium text-gray-500">Completed Offers</p>
            <p className="mt-2 text-3xl font-extrabold text-indigo-600">{dashData?.completedOffers || 0}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm font-medium text-gray-500">Active Offers</p>
            <p className="mt-2 text-3xl font-extrabold text-amber-600">{dashData?.activeOffers.length || 0}</p>
          </div>
        </div>

        <div className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Active / Pending Offers</h2>
          {dashData?.activeOffers && dashData.activeOffers.length > 0 ? (
            <div className="mt-4 space-y-3">
              {dashData.activeOffers.map((offer: any, i: number) => (
                <div key={i} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{offer.name || "Offer"}</p>
                      <p className="text-sm text-gray-500">Added {offer.addedAt ? new Date(offer.addedAt).toLocaleDateString() : "N/A"}</p>
                    </div>
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Pending</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-950">
              <p className="text-gray-500">No active offers yet. Start by exploring the oddsmatcher!</p>
              <Link href="/oddsmatcher" className="mt-3 inline-block text-indigo-600 font-semibold text-sm">View matches &rarr;</Link>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950">
      <nav className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">MP</span>
            <span className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Everyone's A Winner</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/oddsmatcher" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Oddsmatcher</Link>
            <Link href="/world-cup" className="text-sm font-medium text-green-600 hover:text-green-700 font-semibold">World Cup</Link>
            <Link href="/logout" className="text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">Log out</Link>
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}