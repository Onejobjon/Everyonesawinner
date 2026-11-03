import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../lib/auth";

/**
 * FREE ACCESS — the owner's grant panel (/owner/comps).
 *
 * WHY (owner request, 2026-11-02): "How can I give someone free use of the site?
 * I need to get feedback from a human new to match betting." Type a friend's
 * email, give them 30 days of Pro (or any plan), and take it back whenever you
 * like. It works for an address that has not signed up yet: the access starts the
 * moment they register with it.
 *
 * WRITTEN FOR A NON-TECHNICAL OWNER: no ids, no JSON, no "entitlement". Every
 * sentence says what will happen to a person. Underneath, the panel calls the
 * owner-only endpoints in src/server/comps-api.ts, which re-check the owner seat
 * on every request — this page hiding itself is convenience, not security.
 */

type Plan = "starter" | "pro" | "annual";

interface Grant {
  email: string;
  plan: Plan;
  endsAt: string | null;
  permanent?: boolean;
  note?: string;
  grantedBy?: string;
  grantedAt?: string;
  live: boolean;
}

const PLAN_LABEL: Record<Plan, string> = {
  starter: "Starter",
  pro: "Pro",
  annual: "Pro Annual",
};

function prettyDate(iso: string | null | undefined): string {
  if (!iso) return "no end date";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "an unknown date";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "in 24 days" / "today" / "ended 3 days ago" — plain, for the list. */
function daysFromNow(iso: string | null | undefined): string {
  if (!iso) return "runs until you take it back";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "end date unreadable";
  const days = Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days > 1) return `${days} days left`;
  if (days === 1) return "ends tomorrow";
  if (days === 0) return "ends today";
  return `ended ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}

export default function OwnerComps() {
  const { user, sessionStatus } = useAuth();
  const navigate = useNavigate();

  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<Plan>("pro");
  const [days, setDays] = useState("30");
  const [noEndDate, setNoEndDate] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const token = user?.token ?? "";
  const isOwner = user?.owner === true;

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/comps", {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 404) {
        // Not the owner: show nothing at all, the same as every other owner door.
        navigate("/", { replace: true });
        return;
      }
      const data = (await res.json()) as { ok?: boolean; grants?: Grant[] };
      setGrants(data?.grants ?? []);
    } catch {
      setError("Couldn't load the list just now. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, [token, navigate]);

  useEffect(() => {
    if (sessionStatus === "anon") {
      navigate("/login?redirect=" + encodeURIComponent("/owner/comps"), { replace: true });
      return;
    }
    if (sessionStatus === "authed") void load();
  }, [sessionStatus, load, navigate]);

  const grant = async () => {
    setError("");
    setMessage("");
    if (!email.trim()) {
      setError("Type the email address of the person you want to give free access to.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/comps", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          plan,
          days: noEndDate ? undefined : Number(days),
          permanent: noEndDate,
          note: note.trim(),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        appliedToAccount?: boolean;
        grant?: Grant;
      };
      if (!res.ok || !data?.ok) {
        setError(data?.error || "That grant didn't go through. Check the details and try again.");
        return;
      }
      const who = data.grant?.email ?? email.trim();
      setMessage(
        data.appliedToAccount
          ? `Free ${PLAN_LABEL[plan]} access is on for ${who} ${noEndDate ? "until you take it back" : `until ${prettyDate(data.grant?.endsAt)}`}. They can sign in and use the tools right away.`
          : `Saved for ${who}. They haven't signed up yet — the free access starts the moment they do, ${noEndDate ? "and runs until you take it back" : `until ${prettyDate(data.grant?.endsAt)}`}.`,
      );
      setEmail("");
      setNote("");
      await load();
    } catch {
      setError("Couldn't reach the server. Nothing was changed — try again.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (address: string) => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const res = await fetch("/api/comps/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data?.ok) {
        setError(data?.error || "That didn't go through. Try again.");
        return;
      }
      setMessage(`Free access for ${address} has been taken back. They'll see the normal plans next time they load a tool.`);
      await load();
    } catch {
      setError("Couldn't reach the server. Nothing was changed — try again.");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:ring-indigo-900";

  if (sessionStatus === "authed" && !isOwner) {
    // A signed-in customer typing this address: there is nothing here for them.
    return (
      <PageHeader title="Not found" subtitle="There's no page at this address.">
        {null}
      </PageHeader>
    );
  }

  return (
    <PageHeader
      title="Free access"
      subtitle="Give someone the whole site for free — a friend, a reviewer, anyone whose opinion you want. You can take it back whenever you like."
    >
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* THE FORM */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
          <h2 className="text-lg font-semibold">Give someone free access</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            They sign in with this email and every tool is unlocked. No card, no subscription, nothing to cancel.
          </p>

          <div className="mt-5 space-y-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Their email address
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="friend@example.com"
                className={field}
              />
            </label>

            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              What they get
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as Plan)}
                className={field}
              >
                <option value="pro">Pro — every tool</option>
                <option value="starter">Starter — oddsmatcher, calculator, dashboard</option>
                <option value="annual">Pro Annual — every tool</option>
              </select>
            </label>

            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              How many days
              <input
                type="number"
                min={1}
                max={730}
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={noEndDate}
                className={`${field} disabled:opacity-50`}
              />
            </label>

            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={noEndDate}
                onChange={(e) => setNoEndDate(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 dark:border-gray-600"
              />
              <span>
                No end date — it keeps going until I take it back
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  Leave this off unless you really mean it. With a number of days, access stops by itself.
                </span>
              </span>
            </label>

            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Note for yourself (optional)
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Met at the club, testing the lay finder"
                maxLength={200}
                className={field}
              />
            </label>

            <button
              type="button"
              onClick={() => void grant()}
              disabled={busy}
              className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Working…" : "Give free access"}
            </button>
          </div>
        </div>

        {/* THE LIST */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 sm:p-6">
          <h2 className="text-lg font-semibold">People with free access</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {grants.length === 0
              ? "Nobody yet. The first person you add shows up here."
              : `${grants.length} ${grants.length === 1 ? "person" : "people"} on the list.`}
          </p>

          {loading ? (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {grants.map((g) => (
                <li
                  key={g.email}
                  className="rounded-xl border border-gray-200 p-4 dark:border-gray-800"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all text-sm font-semibold">{g.email}</span>
                    <span
                      className={
                        g.live
                          ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-300"
                          : "rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }
                    >
                      {g.live ? "Active" : "Ended"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {PLAN_LABEL[g.plan] ?? g.plan} · {g.permanent ? "no end date" : `free until ${prettyDate(g.endsAt)}`} ·{" "}
                    {daysFromNow(g.endsAt)}
                  </p>
                  {g.note ? (
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">“{g.note}”</p>
                  ) : null}
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    Given by {g.grantedBy || "you"} on {prettyDate(g.grantedAt)}
                  </p>
                  <button
                    type="button"
                    onClick={() => void revoke(g.email)}
                    disabled={busy}
                    className="mt-3 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    Take it back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {error ? (
        <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          {message}
        </p>
      ) : null}
    </PageHeader>
  );
}
