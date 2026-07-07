import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface User {
  email: string;
  name: string;
  token: string;
  subscription: boolean; // true if user has paid
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => boolean;
  signup: (name: string, email: string, password: string) => boolean;
  logout: () => void;
  activateSubscription: () => void;
  checkAuth: () => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getUsers(): Record<string, { name: string; email: string; password: string; subscription: boolean; token: string }> {
  try {
    return JSON.parse(localStorage.getItem("eaw_users") || "{}");
  } catch {
    return {};
  }
}

function saveUsers(users: Record<string, any>) {
  localStorage.setItem("eaw_users", JSON.stringify(users));
}

function generateToken(): string {
  return "tok_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  // Restore session on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("eaw_session");
      if (stored) {
        const parsed = JSON.parse(stored);
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

  const login = (email: string, password: string): boolean => {
    const users = getUsers();
    const record = users[email.toLowerCase()];
    if (!record || record.password !== password) return false;

    const u: User = {
      email: record.email,
      name: record.name,
      token: record.token,
      subscription: record.subscription,
    };
    setUser(u);
    localStorage.setItem("eaw_session", JSON.stringify(u));
    return true;
  };

  const signup = (name: string, email: string, password: string): boolean => {
    const users = getUsers();
    const key = email.toLowerCase();
    if (users[key]) return false; // already exists

    const token = generateToken();
    users[key] = { name, email, password, subscription: false, token };
    saveUsers(users);

    const u: User = { email, name, token, subscription: false };
    setUser(u);
    localStorage.setItem("eaw_session", JSON.stringify(u));
    return true;
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("eaw_session");
  };

  const activateSubscription = () => {
    if (!user) return;
    const updated: User = { ...user, subscription: true };
    setUser(updated);
    localStorage.setItem("eaw_session", JSON.stringify(updated));

    // Also update the users store
    const users = getUsers();
    const key = user.email.toLowerCase();
    if (users[key]) {
      users[key].subscription = true;
      saveUsers(users);
    }
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