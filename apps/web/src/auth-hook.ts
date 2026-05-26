import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

export interface CurrentUser {
  id: string;
  sub: string;
  username: string;
  displayName: string;
  groups: string[];
  managedAgents: string[];
  picture: string | null;
}

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: CurrentUser };

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const user = await api.get<CurrentUser | null>("/api/me");
        if (cancelled) return;
        if (!user) {
          setState({ status: "signed-out" });
          return;
        }
        setState({ status: "signed-in", user });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: "signed-out" });
          return;
        }
        setState({ status: "signed-out" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
