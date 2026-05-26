import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface AuthUser {
  id: string;
  sub: string;
  username: string;
  displayName: string;
  groups: string[];
  managedAgents: string[];
  picture: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  login: (redirect?: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Scribe uses the server-side OIDC flow + scribe_session cookie. The provider
// reads /api/me, which returns the user directly (or null when signed out).
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me", { credentials: "same-origin" });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as AuthUser | null;
          setUser(body);
        } else {
          setUser(null);
        }
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isLoading,
      login: (redirect = window.location.pathname) => {
        window.location.assign(`/auth/login?redirect=${encodeURIComponent(redirect)}`);
      },
      logout: async () => {
        await fetch("/auth/logout", { credentials: "same-origin" });
        setUser(null);
      },
    }),
    [user, isLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
