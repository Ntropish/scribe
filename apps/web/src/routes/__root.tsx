import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { NavShellLayout } from "@trivorn/nav-shell";
import "@trivorn/nav-shell/src/NavShell.css";
import { useNavPosition } from "@trivorn/theme-client/react";
import { Home, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../auth-context";
import { themeClient } from "../theme-client";

const LOGIN_ATTEMPT_KEY = "scribe:auth:login_attempt_at";
const LOGIN_ATTEMPT_WINDOW_MS = 10_000;

function AppShell() {
  const { user, isLoading, login, logout } = useAuth();
  const location = useLocation();
  const portraitPosition = useNavPosition();
  const [authStalled, setAuthStalled] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    themeClient.apply().catch(() => {
      // Theme failure shouldn't block the app.
    });
  }, [isLoading]);

  useEffect(() => {
    if (isLoading || user) {
      sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
      return;
    }
    const lastAttempt = Number(sessionStorage.getItem(LOGIN_ATTEMPT_KEY) ?? 0);
    if (Date.now() - lastAttempt < LOGIN_ATTEMPT_WINDOW_MS) {
      setAuthStalled(true);
      return;
    }
    sessionStorage.setItem(LOGIN_ATTEMPT_KEY, String(Date.now()));
    login();
  }, [user, isLoading, login]);

  if (isLoading) {
    return <div className="auth-screen">Loading...</div>;
  }

  if (!user) {
    if (authStalled) {
      return (
        <div className="auth-screen">
          <p>We couldn&rsquo;t complete sign-in automatically.</p>
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
              login();
            }}
          >
            Sign in
          </button>
        </div>
      );
    }
    return <div className="auth-screen">Redirecting to sign in...</div>;
  }

  const navItems = [
    { icon: Home, label: "Spaces", href: "/spaces" },
    { icon: Search, label: "Search", href: "/search" },
  ];

  return (
    <NavShellLayout
      items={navItems}
      user={{
        name: user.displayName ?? user.username,
        ...(user.picture ? { avatarUrl: user.picture } : {}),
      }}
      currentPath={location.pathname}
      onLogout={() => void logout()}
      authDashboardUrl="https://auth.trivorn.org"
      portraitPosition={portraitPosition}
    >
      <main className="scribe-main">
        <Outlet />
      </main>
    </NavShellLayout>
  );
}

export const Route = createRootRoute({ component: AppShell });
