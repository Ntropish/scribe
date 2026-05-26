import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useAuth } from "../auth-hook";

function GlobalSearch() {
  const [q, setQ] = useState("");
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = q.trim();
    if (!value) return;
    window.location.assign(`/search?q=${encodeURIComponent(value)}`);
  }
  return (
    <form className="scribe-nav__search" onSubmit={onSubmit}>
      <input
        type="search"
        placeholder="Search transcripts"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label="Search"
      />
    </form>
  );
}

function AppShell() {
  const auth = useAuth();
  return (
    <div className="scribe-app">
      <nav className="scribe-nav">
        <Link to="/" className="scribe-nav__brand">scribe</Link>
        <Link to="/spaces">Spaces</Link>
        <GlobalSearch />
        <div style={{ marginLeft: "auto" }}>
          {auth.status === "signed-in" ? (
            <span>
              {auth.user.displayName} {" "}
              <a href="/auth/logout">sign out</a>
            </span>
          ) : auth.status === "signed-out" ? (
            <a href="/auth/login">Sign in</a>
          ) : null}
        </div>
      </nav>
      <main className="scribe-main">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createRootRoute({ component: AppShell });
