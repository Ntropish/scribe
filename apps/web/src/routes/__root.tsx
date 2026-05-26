import { Outlet, createRootRoute } from "@tanstack/react-router";

function AppShell() {
  return (
    <>
      <header>
        <h1>scribe</h1>
      </header>
      <Outlet />
    </>
  );
}

export const Route = createRootRoute({ component: AppShell });
