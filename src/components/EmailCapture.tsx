import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

/**
 * Email-capture form (name + email) that posts to /api/leads and stores the
 * lead server-side. Reused on the homepage and the /free-bets page.
 */
export default function EmailCapture({ source = "homepage" }: { source?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, source }),
      });
      if (!res.ok) throw new Error("submit failed");
      setStatus("done");
    } catch {
      setStatus("error");
      setErrorMsg("Couldn't save your details. Please try again in a moment.");
    }
  }

  return (
    <section className="py-16 md:py-20 bg-gray-50 dark:bg-gray-900/50">
      <div className="mx-auto max-w-xl px-6">
        {status === "done" ? (
          <div className="rounded-2xl border border-green-200 bg-white p-10 text-center shadow-sm dark:border-green-900 dark:bg-gray-950">
            <span className="text-5xl">🎉</span>
            <h3 className="mt-4 text-2xl font-bold tracking-tight">Details saved.</h3>
            <p className="mt-3 text-gray-600 dark:text-gray-400">
              Thanks{name ? ` ${name.split(" ")[0]}` : ""} — your details are saved. We aren't sending emails yet.
            </p>
            <Link
              to="/signup"
              className="mt-6 inline-block rounded-xl bg-indigo-600 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all"
            >
              Start matching now →
            </Link>
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <h3 className="text-2xl font-bold tracking-tight">Get told when this opens</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              We're collecting a list for launch. Nothing is sent yet and there is no newsletter running — leave your details and we'll contact you once there is something to send.
            </p>
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="lead-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  First name
                </label>
                <input
                  id="lead-name"
                  type="text"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label htmlFor="lead-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Email
                </label>
                <input
                  id="lead-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              {status === "error" && (
                <p className="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
              )}
              <button
                type="submit"
                disabled={status === "submitting"}
                className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all disabled:opacity-60"
              >
                {status === "submitting" ? "Saving…" : "Keep me posted"}
              </button>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
