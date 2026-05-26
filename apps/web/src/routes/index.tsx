import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as rootRoute } from "./__root";
import { useAuth } from "../auth-context";

function Index() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (isLoading) return;
    if (user) void navigate({ to: "/spaces" });
  }, [user, isLoading, navigate]);
  return null;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Index,
});
