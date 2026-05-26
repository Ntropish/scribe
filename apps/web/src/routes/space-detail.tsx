import { Link, createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";

interface Space {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  memberRole: "owner" | "editor" | "viewer" | null;
}

type SessionState = "recording" | "paused" | "stopped" | "finalized";

interface Session {
  id: string;
  title: string;
  state: SessionState;
  startedAt: string;
}

function canEdit(role: Space["memberRole"]): boolean {
  return role === "owner" || role === "editor";
}

function SpaceDetail() {
  const { slug } = useParams({ from: "/spaces/$slug" });
  const navigate = useNavigate();
  const [space, setSpace] = useState<Space | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const loadSpace = useCallback(async () => {
    try {
      const data = await api.get<Space>(`/api/spaces/${encodeURIComponent(slug)}`);
      setSpace(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 403 ? "Access denied" : err.message);
      else setError(String(err));
    }
  }, [slug]);

  const loadSessions = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    try {
      const data = await api.get<Session[]>(`/api/spaces/${encodeURIComponent(slug)}/sessions${qs ? `?${qs}` : ""}`);
      setSessions(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }, [slug, q, from, to]);

  useEffect(() => {
    void loadSpace();
  }, [loadSpace]);

  useEffect(() => {
    if (space) void loadSessions();
  }, [space, loadSessions]);

  async function newSession() {
    try {
      const created = await api.post<{ id: string }>(`/api/spaces/${encodeURIComponent(slug)}/sessions`, {});
      void navigate({
        to: "/spaces/$slug/sessions/$sessionId",
        params: { slug, sessionId: created.id },
      });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  if (error) return <div className="scribe-error">{error}</div>;
  if (!space) return <p className="scribe-empty">loading</p>;

  const editor = canEdit(space.memberRole);

  return (
    <>
      <div className="scribe-header">
        <div className="scribe-header__row">
          <h1 style={{ margin: 0 }}>{space.name}</h1>
          <span className="scribe-card__role">{space.memberRole ?? "public"}</span>
          {space.memberRole === "owner" && (
            <Link to="/spaces/$slug/grants" params={{ slug }}>Members</Link>
          )}
        </div>
        {space.description && <p style={{ margin: 0 }}>{space.description}</p>}
      </div>
      <div className="scribe-row" style={{ gap: "0.6rem", marginBottom: "0.6rem" }}>
        <input
          placeholder="search sessions by title"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value ? `${e.currentTarget.value}T00:00:00Z` : "")}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value ? `${e.currentTarget.value}T23:59:59Z` : "")}
        />
        <button className="secondary" onClick={() => void loadSessions()}>Apply</button>
        {editor && <button onClick={newSession}>New session</button>}
      </div>
      {!sessions ? (
        <p className="scribe-empty">loading sessions</p>
      ) : sessions.length === 0 ? (
        <p className="scribe-empty">No sessions yet.</p>
      ) : (
        <table className="scribe-table">
          <thead>
            <tr><th>Started</th><th>Title</th><th>State</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.startedAt).toLocaleString()}</td>
                <td>
                  <Link to="/spaces/$slug/sessions/$sessionId" params={{ slug, sessionId: s.id }}>
                    {s.title || "(untitled)"}
                  </Link>
                </td>
                <td><span className={`scribe-state scribe-state--${s.state}`}>{s.state}</span></td>
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
  path: "/spaces/$slug",
  component: SpaceDetail,
});
