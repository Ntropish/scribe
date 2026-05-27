import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";

interface Grant {
  id: string;
  groupName: string;
  role: "maintainer" | "editor" | "viewer";
  createdAt: string;
}

function Grants() {
  const { slug } = useParams({ from: "/spaces/$slug/grants" });
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState("");
  const [roleInput, setRoleInput] = useState<"maintainer" | "editor" | "viewer">("viewer");

  const load = useCallback(async () => {
    try {
      const data = await api.get<Grant[]>(`/api/spaces/${encodeURIComponent(slug)}/grants`);
      setGrants(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setGrant(group: string, role: "maintainer" | "editor" | "viewer") {
    try {
      await api.put<Grant>(`/api/spaces/${encodeURIComponent(slug)}/grants/${encodeURIComponent(group)}`, { role });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  async function removeGrant(group: string) {
    try {
      await api.delete(`/api/spaces/${encodeURIComponent(slug)}/grants/${encodeURIComponent(group)}`);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  return (
    <>
      <div className="scribe-header__row">
        <h1 style={{ margin: 0 }}>Members</h1>
        <Link to="/spaces/$slug" params={{ slug }}>back to space</Link>
      </div>
      {error && <div className="scribe-error">{error}</div>}
      <div className="scribe-row" style={{ marginBottom: "0.6rem" }}>
        <input
          placeholder="group name"
          value={groupInput}
          onChange={(e) => setGroupInput(e.currentTarget.value)}
        />
        <select value={roleInput} onChange={(e) => setRoleInput(e.currentTarget.value as "maintainer" | "editor" | "viewer")}>
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
          <option value="maintainer">maintainer</option>
        </select>
        <button
          disabled={!groupInput}
          onClick={() => {
            if (groupInput) {
              void setGrant(groupInput, roleInput);
              setGroupInput("");
            }
          }}
        >
          Grant
        </button>
      </div>
      {!grants ? (
        <p className="scribe-empty">loading</p>
      ) : grants.length === 0 ? (
        <p className="scribe-empty">No group grants yet. The space creator is the owner; grants extend access to additional groups.</p>
      ) : (
        <table className="scribe-table">
          <thead>
            <tr><th>Group</th><th>Role</th><th></th></tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.groupName}</td>
                <td>
                  <select
                    value={g.role}
                    onChange={(e) => void setGrant(g.groupName, e.currentTarget.value as "maintainer" | "editor" | "viewer")}
                  >
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                    <option value="maintainer">maintainer</option>
                  </select>
                </td>
                <td>
                  <button className="secondary" onClick={() => void removeGrant(g.groupName)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/$slug/grants",
  component: Grants,
});
