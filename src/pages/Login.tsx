import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../lib/auth";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const redirect = searchParams.get("redirect") || "/";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    setSubmitting(true);
    const err = await login(email, password);
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    // After login: everyone lands on the free bet offers page, unless they were
    // sent here from a specific page that needs a session. The instant-wins feed
    // lives on the dashboard and is for people who already know the mechanics, so
    // it is no longer the default destination.
    if (redirect && redirect !== "/") {
      navigate(redirect);
    } else {
      navigate("/free-bets");
    }
  };

  return (
    <PageHeader title="Welcome back" subtitle="Sign in to your account to continue.">
      <div className="mx-auto max-w-md">

        {redirect !== "/" && (
          <div className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            🔒 Sign in to access the odds finder and profit tools.
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          {error && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" placeholder="john@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" placeholder="Your password" />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all disabled:opacity-60">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">
          We store what you type here — see how in our{" "}
          <Link to="/privacy" className="text-indigo-600 underline hover:text-indigo-700 dark:text-indigo-400">
            Privacy notice
          </Link>
          .
        </p>

        <p className="mt-8 text-center text-sm text-gray-500">
          Don't have an account? <Link to="/signup" className="text-indigo-600 hover:text-indigo-700 font-medium">Create one</Link>
        </p>
      </div>
    </PageHeader>
  );
}