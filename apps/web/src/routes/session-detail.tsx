import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";
import { useAuth } from "../auth-hook";
import {
  useRecorder,
  type LineEvent,
  type PartialEvent,
  type StateEvent,
} from "../recorder-hook";
import { TranscriptView, type TranscriptLine } from "../transcript-view";

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

interface SpacePayload {
  id: string;
  slug: string;
  memberRole: "owner" | "editor" | "viewer" | null;
}

function canEditFromRole(role: SpacePayload["memberRole"]): boolean {
  return role === "owner" || role === "editor";
}

function toTranscriptLine(line: Line): TranscriptLine {
  return {
    id: line.id,
    line_index: line.line_index,
    start_ms: line.start_ms,
    end_ms: line.end_ms,
    text: line.text,
    raw_speaker_label: line.raw_speaker_label,
    resolved_speaker: line.resolved_speaker,
  };
}

function SessionDetail() {
  const { slug, sessionId } = useParams({ from: "/spaces/$slug/sessions/$sessionId" });
  const auth = useAuth();
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [space, setSpace] = useState<SpacePayload | null>(null);
  const [lines, setLines] = useState<Map<string, Line>>(new Map());
  const [partial, setPartial] = useState<string | null>(null);
  const [serverState, setServerState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadSession() {
    try {
      const data = await api.get<SessionPayload>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      setSession(data);
      setLines(new Map(data.lines.map((l) => [l.id, l])));
      setServerState(data.state);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err.status === 403 ? "Access denied" : err.message);
      else setError(String(err));
    }
  }

  async function loadSpace() {
    try {
      const data = await api.get<SpacePayload>(`/api/spaces/${encodeURIComponent(slug)}`);
      setSpace(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  useEffect(() => {
    void loadSpace();
  }, [slug]);

  useEffect(() => {
    void loadSession();
  }, [sessionId]);

  const onLine = useCallback((evt: LineEvent) => {
    setLines((prev) => {
      const next = new Map(prev);
      next.set(evt.id, evt);
      return next;
    });
    setPartial(null);
  }, []);

  const onLineUpdated = useCallback((evt: LineEvent) => {
    setLines((prev) => {
      const next = new Map(prev);
      next.set(evt.id, evt);
      return next;
    });
  }, []);

  const onPartial = useCallback((evt: PartialEvent) => {
    setPartial(evt.text);
  }, []);

  const onState = useCallback((evt: StateEvent) => {
    setServerState(evt.state);
  }, []);

  const recorder = useRecorder({ sessionId, onLine, onLineUpdated, onPartial, onState });

  async function finalize() {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/finalize`);
      await loadSession();
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
      await loadSession();
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
  const effectiveState = serverState ?? session.state;
  const recorderBusy = recorder.state === "error" && recorder.errorMessage?.startsWith("recorder_busy:");
  const finalized = effectiveState === "finalized";
  const canEdit = canEditFromRole(space?.memberRole ?? null) || isAdmin;

  const transcriptLines = Array.from(lines.values()).map(toTranscriptLine);

  return (
    <>
      <div className="scribe-header">
        <div className="scribe-header__row">
          <Link to="/spaces/$slug" params={{ slug }}>back</Link>
          <h1 style={{ margin: 0 }}>{session.title || "(untitled)"}</h1>
          <span className={`scribe-state scribe-state--${effectiveState}`}>{effectiveState}</span>
        </div>
        <div className="scribe-row">
          <span>Started {new Date(session.startedAt).toLocaleString()}</span>
          {!finalized ? (
            canEdit && <button onClick={finalize} disabled={busy}>Finalize</button>
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

      {recorderBusy && (
        <div className="scribe-error">
          Another client is recording this session.{" "}
          <button className="secondary" onClick={() => window.location.reload()}>Refresh</button>
        </div>
      )}

      {!finalized && !recorderBusy && canEdit && (
        <div className="scribe-row" style={{ margin: "0.6rem 0" }}>
          {recorder.state === "idle" && <button onClick={() => void recorder.start()}>Record</button>}
          {recorder.state === "requesting_mic" && <button disabled>Requesting mic</button>}
          {recorder.state === "recording" && (
            <>
              <button className="secondary" onClick={recorder.pause}>Pause</button>
              <button className="secondary" onClick={() => void recorder.stop()}>Stop</button>
              <span style={{ color: "var(--danger)" }}>recording</span>
            </>
          )}
          {recorder.state === "paused" && (
            <>
              <button onClick={recorder.resume}>Resume</button>
              <button className="secondary" onClick={() => void recorder.stop()}>Stop</button>
              <span style={{ color: "var(--muted)" }}>paused</span>
            </>
          )}
          {recorder.state === "stopping" && <span>stopping</span>}
          {recorder.state === "error" && recorder.errorMessage && (
            <span className="scribe-error" style={{ padding: "0 0.6rem" }}>{recorder.errorMessage}</span>
          )}
        </div>
      )}

      <TranscriptView
        spaceSlug={slug}
        sessionId={sessionId}
        lines={transcriptLines}
        partial={partial}
        finalized={finalized}
        canEdit={canEdit}
      />
    </>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/$slug/sessions/$sessionId",
  component: SessionDetail,
});
