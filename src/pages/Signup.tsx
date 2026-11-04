import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../lib/auth";

export default function Signup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signup } = useAuth();
  // Only a same-site path is honoured, so this cannot become an open redirect.
  const requested = searchParams.get("redirect") || "";
  const redirect = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/subscribe";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name || !email || !password) {
      setError("All fields are required.");
      return;
    }
    setSubmitting(true);
    const err = await signup(name, email, password);
    setSubmitting(false);
    if (err) {
      setError(err);
      return;
    }
    // After signup, go where they were headed — /subscribe?plan=pro, say — so a
    // visitor who picked a plan before signing up comes back to it.
    navigate(redirect);
  };

  return (
    <PageHeader title="Create your account" subtitle="Start turning free bets into profit today.">
      <div className="mx-auto max-w-md">

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          {error && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-400">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" placeholder="John Smith" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" placeholder="john@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm dark:border-gray-700 dark:bg-gray-900" placeholder="At least 6 characters" minLength={6} />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all disabled:opacity-60">
            {submitting ? "Creating account…" : "Create account"}
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
          Already have an account? <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">Sign in</Link>
        </p>
      </div>
    </PageHeader>
    );
}