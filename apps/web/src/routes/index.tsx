import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as rootRoute } from "./__root";
import { useAuth } from "../auth-hook";

function Index() {
  const auth = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (auth.status === "signed-in") {
      void navigate({ to: "/spaces" });
    } else if (auth.status === "signed-out") {
      window.location.assign("/auth/login");
    }
  }, [auth.status, navigate]);
  return null;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Index,
});
