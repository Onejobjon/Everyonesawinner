import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const redirect = searchParams.get("redirect") || "/";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    const ok = login(email, password);
    if (!ok) {
      setError("Invalid email or password.");
      return;
    }
    // After login: if subscribed → dashboard, else → pricing
    const currentUser = JSON.parse(localStorage.getItem("eaw_session") || "{}");
    if (currentUser?.subscription) {
      navigate("/dashboard");
    } else if (redirect && redirect !== "/") {
      navigate(redirect);
    } else {
      navigate("/#pricing");
    }
  };

  return (
    <div className="min-h-dvh page-bg font-['Inter',system-ui,sans-serif]">
      <nav className="border-b border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-lg bg-indigo-600 p-2 text-white font-bold text-lg">EAW</span>
            <span className="text-xl font-bold tracking-tight">Everyone's A Winner</span>
          </Link>
          <Link to="/signup" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">Create account →</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight text-center">Welcome back</h1>
        <p className="mt-2 text-center text-gray-600 dark:text-gray-400">Sign in to your account to continue.</p>

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
          <button type="submit"
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition-all">
            Sign in
          </button>
        </form>

        <p className="mt-8 text-center text-sm text-gray-500">
          Don't have an account? <Link to="/signup" className="text-indigo-600 hover:text-indigo-700 font-medium">Create one</Link>
        </p>
      </div>
    </div>
  );
}