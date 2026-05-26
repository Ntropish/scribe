import { createRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";

interface Me {
  displayName: string;
  username: string;
  groups: string[];
}

function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: Me | null) => setMe(data))
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) return <main>loading</main>;
  if (me === null) {
    return (
      <main>
        <a href="/auth/login">Sign in</a>
      </main>
    );
  }
  return (
    <main>
      <p>signed in as {me.displayName}</p>
      <p>groups: {me.groups.join(", ") || "none"}</p>
      <a href="/auth/logout">Sign out</a>
    </main>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});
