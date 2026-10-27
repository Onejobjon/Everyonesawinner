import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export type Plan = "starter" | "pro" | "annual";

interface User {
  email: string;
  name: string;
  token: string;
  subscription: boolean; // true if user has paid
  plan: Plan | null;     // which tier they're on
}

/**
 * Whether the SERVER has confirmed who this visitor is.
 *  checking — asking /api/me right now
 *  authed   — the server resolved the session token to a real account
 *  anon     — no token, or the server rejected it
 *  error    — the account service could not be reached (treat as no access)
 */
export type SessionStatus = "checking" | "authed" | "anon" | "error";

interface AuthContextType {
  user: User | null;
  /** Server-verified session state. This is what the paywall reads. */
  sessionStatus: SessionStatus;
  /** Resolve to `null` on success, or a user-facing error message on failure. */
  login: (email: string, password: string) => Promise<string | null>;
  signup: (name: string, email: string, password: string) => Promise<string | null>;
  logout: () => void;
  activateSubscription: (plan: Plan) => void;
  /** Re-ask the server what this session's plan and subscription are. */
  refresh: () => Promise<void>;
  /** True only when the server has confirmed the session. */
  checkAuth: () => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

/** True when a plan grants access to Pro-only features (Lay Bet Finder). */
export function isProPlan(plan: Plan | null | undefined): boolean {
  return plan === "pro" || plan === "annual";
}

/** POST JSON to a server endpoint; returns the parsed body (never throws). */
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return data as T;
}

interface AuthResponse {
  ok: boolean;
  user?: User;
  error?: string;
}

function readStoredSession(): User | null {
  try {
    const stored = localStorage.getItem("eaw_session");
    if (!stored) return null;
    const parsed = JSON.parse(stored) as User;
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Ask the server what this token actually grants.
 *
 * SECURITY (2026-10-27): the browser's copy of the session is only a hint. Plan
 * and subscription come from `GET /api/me`, which resolves the token against
 * the server-side session store. A hand-written localStorage entry with an
 * invented token (e.g. `token: "deadbeef"`) returns 401 here and gets the
 * subscribe screen — previously it rendered every Pro tool.
 */
async function verifyWithServer(token: string): Promise<{ user: User } | { status: "anon" | "error" }> {
  try {
    const res = await fetch("/api/me", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { status: "anon" };
    if (!res.ok) return { status: "error" };
    const data = (await res.json()) as { ok?: boolean; user?: User };
    if (data?.ok && data.user) return { user: { ...data.user, token } };
    return { status: "anon" };
  } catch {
    // Network failure or 5xx: fail closed — no access, and say so.
    return { status: "error" };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("checking");

  /** Re-verify the stored token with the server. */
  const refresh = useCallback(async () => {
    const stored = readStoredSession();
    if (!stored) {
      setUser(null);
      setSessionStatus("anon");
      return;
    }
    const result = await verifyWithServer(stored.token);
    if ("user" in result) {
      setUser(result.user);
      localStorage.setItem("eaw_session", JSON.stringify(result.user));
      setSessionStatus("authed");
      return;
    }
    if (result.status === "anon") {
      setUser(null);
      localStorage.removeItem("eaw_session");
    }
    setSessionStatus(result.status);
  }, []);

  // Verify on mount — never trust the stored object by itself.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const checkAuth = (): boolean => sessionStatus === "authed" && !!user?.token;

  const login = async (email: string, password: string): Promise<string | null> => {
    try {
      const res = await apiPost<AuthResponse>("/api/login", { email, password });
      if (res?.ok && res.user?.token) {
        setUser(res.user);
        localStorage.setItem("eaw_session", JSON.stringify(res.user));
        setSessionStatus("authed");
        return null;
      }
      return res?.error || "Invalid email or password.";
    } catch {
      return "Couldn't reach the server. Please try again.";
    }
  };

  const signup = async (name: string, email: string, password: string): Promise<string | null> => {
    try {
      const res = await apiPost<AuthResponse>("/api/signup", { name, email, password });
      if (res?.ok && res.user?.token) {
        setUser(res.user);
        localStorage.setItem("eaw_session", JSON.stringify(res.user));
        setSessionStatus("authed");
        return null;
      }
      return res?.error || "Could not create your account.";
    } catch {
      return "Couldn't reach the server. Please try again.";
    }
  };

  const logout = () => {
    const stored = readStoredSession();
    if (stored?.token) {
      // Revoke server-side too, so a copied token stops working.
      void fetch("/api/logout", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${stored.token}` },
        body: JSON.stringify({ token: stored.token }),
      }).catch(() => {});
    }
    setUser(null);
    setSessionStatus("anon");
    localStorage.removeItem("eaw_session");
  };

  /**
   * Local, optimistic only: the subscribe-success page uses this for a nicer
   * message. It can NEVER unlock a tool — the paywall asks /api/me, which reads
   * the plan from the account record, and that only changes when billing says so.
   */
  const activateSubscription = (plan: Plan) => {
    if (!user) return;
    setUser({ ...user, subscription: true, plan });
  };

  return (
    <AuthContext.Provider
      value={{ user, sessionStatus, login, signup, logout, activateSubscription, refresh, checkAuth }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
