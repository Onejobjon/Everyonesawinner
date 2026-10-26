import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Plan = "starter" | "pro" | "annual";

interface User {
  email: string;
  name: string;
  token: string;
  subscription: boolean; // true if user has paid
  plan: Plan | null;     // which tier they're on
}

interface AuthContextType {
  user: User | null;
  /** Resolve to `null` on success, or a user-facing error message on failure. */
  login: (email: string, password: string) => Promise<string | null>;
  signup: (name: string, email: string, password: string) => Promise<string | null>;
  logout: () => void;
  activateSubscription: (plan: Plan) => void;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  // Restore the session on mount (the user record + token, no password).
  useEffect(() => {
    try {
      const stored = localStorage.getItem("eaw_session");
      if (stored) {
        const parsed = JSON.parse(stored) as User;
        // Backward-compat: sessions saved before the plan field existed
        if (parsed.plan === undefined) parsed.plan = parsed.subscription ? "starter" : null;
        setUser(parsed);
      }
    } catch {
      localStorage.removeItem("eaw_session");
    }
  }, []);

  const checkAuth = (): boolean => {
    try {
      const stored = localStorage.getItem("eaw_session");
      if (!stored) return false;
      const parsed = JSON.parse(stored) as User;
      return !!parsed.token;
    } catch {
      return false;
    }
  };

  const login = async (email: string, password: string): Promise<string | null> => {
    try {
      const res = await apiPost<AuthResponse>("/api/login", { email, password });
      if (res?.ok && res.user) {
        setUser(res.user);
        localStorage.setItem("eaw_session", JSON.stringify(res.user));
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
      if (res?.ok && res.user) {
        setUser(res.user);
        localStorage.setItem("eaw_session", JSON.stringify(res.user));
        return null;
      }
      return res?.error || "Could not create your account.";
    } catch {
      return "Couldn't reach the server. Please try again.";
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("eaw_session");
  };

  const activateSubscription = (plan: Plan) => {
    if (!user) return;
    const updated: User = { ...user, subscription: true, plan };
    setUser(updated);
    localStorage.setItem("eaw_session", JSON.stringify(updated));
  };

  return (
    <AuthContext.Provider value={{ user, login, signup, logout, activateSubscription, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
