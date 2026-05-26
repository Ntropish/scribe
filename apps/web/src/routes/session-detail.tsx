import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";
import { useAuth } from "../auth-hook";

type SessionState = "recording" | "paused" | "stopped" | "finalized";

interface Line {
  id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  raw_speaker_label: string;
  resolved_speaker: string;
}

interface SessionPayload {
  id: string;
  spaceId: string;
  spaceSlug: string;
  title: string;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
  finalizedAt: string | null;
  finalizedBySub: string | null;
  createdBySub: string;
  lines: Line[];
}

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function SessionDetail() {
  const { slug, sessionId } = useParams({ from: "/spaces/$slug/sessions/$sessionId" });
  const auth = useAuth();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await api.get<SessionPayload>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      setSession(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 403 ? "Access denied" : err.message);
      else setError(String(err));
    }
  }

  useEffect(() => {
    void load();
  }, [sessionId]);

  async function finalize() {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/finalize`);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unfinalize() {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/unfinalize`);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="scribe-error">{error}</div>;
  if (!session) return <p className="scribe-empty">loading</p>;

  const isAdmin = auth.status === "signed-in" && auth.user.groups.includes("admin");

  return (
    <>
      <div className="scribe-header">
        <div className="scribe-header__row">
          <Link to="/spaces/$slug" params={{ slug }}>back</Link>
          <h1 style={{ margin: 0 }}>{session.title || "(untitled)"}</h1>
          <span className={`scribe-state scribe-state--${session.state}`}>{session.state}</span>
        </div>
        <div className="scribe-row">
          <span>Started {new Date(session.startedAt).toLocaleString()}</span>
          {session.state !== "finalized" ? (
            <button onClick={finalize} disabled={busy}>Finalize</button>
          ) : (
            <>
              <span>
                Finalized {session.finalizedAt ? new Date(session.finalizedAt).toLocaleString() : ""}
              </span>
              {isAdmin && (
                <button className="secondary" onClick={unfinalize} disabled={busy}>Unfinalize</button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="scribe-empty" style={{ marginTop: "1rem" }}>
        Recorder controls land in the recorder UI bead.
      </div>

      <div className="scribe-transcript">
        {session.lines.length === 0 ? (
          <p className="scribe-empty">No lines yet.</p>
        ) : (
          session.lines.map((line) => (
            <div className="scribe-line" key={line.id}>
              <div className="scribe-line__ts">{formatMs(line.start_ms)}</div>
              <div className="scribe-line__speaker">{line.resolved_speaker}</div>
              <div>{line.text}</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/$slug/sessions/$sessionId",
  component: SessionDetail,
});
