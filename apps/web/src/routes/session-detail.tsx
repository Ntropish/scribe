import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Route as rootRoute } from "./__root";
import { api, ApiError } from "../api";
import { useAuth, type AuthState } from "../auth-context";
import {
  useRecorder,
  type LineEvent,
  type PartialEvent,
  type RecorderApi,
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
  spaceSlug: string;
  title: string;
  state: SessionState;
  startedAt: string;
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

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.status === 403 ? "Access denied" : err.message;
  return String(err);
}

function SessionHeader({
  slug,
  session,
  effectiveState,
  canEdit,
  isAdmin,
  busy,
  onFinalize,
  onUnfinalize,
}: {
  slug: string;
  session: SessionPayload;
  effectiveState: SessionState;
  canEdit: boolean;
  isAdmin: boolean;
  busy: boolean;
  onFinalize: () => void;
  onUnfinalize: () => void;
}) {
  const finalized = effectiveState === "finalized";
  return (
    <div className="scribe-header">
      <div className="scribe-header__row">
        <Link to="/spaces/$slug" params={{ slug }}>back</Link>
        <h1 style={{ margin: 0 }}>{session.title || "(untitled)"}</h1>
        <span className={`scribe-state scribe-state--${effectiveState}`}>{effectiveState}</span>
      </div>
      <div className="scribe-row">
        <span>Started {new Date(session.startedAt).toLocaleString()}</span>
        {!finalized && canEdit && (
          <button onClick={onFinalize} disabled={busy}>Finalize</button>
        )}
        {finalized && (
          <>
            <span>
              Finalized {session.finalizedAt ? new Date(session.finalizedAt).toLocaleString() : ""}
            </span>
            {isAdmin && (
              <button className="secondary" onClick={onUnfinalize} disabled={busy}>Unfinalize</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RecorderControls({ recorder }: { recorder: RecorderApi }) {
  if (recorder.state === "idle") {
    return <button onClick={() => void recorder.start()}>Record</button>;
  }
  if (recorder.state === "requesting_mic") {
    return <button disabled>Requesting mic</button>;
  }
  if (recorder.state === "recording") {
    return (
      <>
        <button className="secondary" onClick={recorder.pause}>Pause</button>
        <button className="secondary" onClick={() => void recorder.stop()}>Stop</button>
        <span style={{ color: "var(--danger)" }}>recording</span>
      </>
    );
  }
  if (recorder.state === "paused") {
    return (
      <>
        <button onClick={recorder.resume}>Resume</button>
        <button className="secondary" onClick={() => void recorder.stop()}>Stop</button>
        <span style={{ color: "var(--muted)" }}>paused</span>
      </>
    );
  }
  if (recorder.state === "stopping") return <span>stopping</span>;
  if (recorder.state === "error") {
    return (
      <>
        <button onClick={() => void recorder.start()}>Try again</button>
        {recorder.errorMessage && (
          <span className="scribe-error" style={{ padding: "0 0.6rem" }}>{recorder.errorMessage}</span>
        )}
      </>
    );
  }
  return null;
}

function useSessionData(sessionId: string, slug: string) {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [space, setSpace] = useState<SpacePayload | null>(null);
  const [lines, setLines] = useState<Map<string, Line>>(new Map());
  const [serverState, setServerState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const data = await api.get<SessionPayload>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      setSession(data);
      setLines(new Map(data.lines.map((l) => [l.id, l])));
      setServerState(data.state);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [sessionId]);

  const loadSpace = useCallback(async () => {
    try {
      setSpace(await api.get<SpacePayload>(`/api/spaces/${encodeURIComponent(slug)}`));
    } catch (err) {
      setError(describeError(err));
    }
  }, [slug]);

  useEffect(() => { void loadSpace(); }, [loadSpace]);
  useEffect(() => { void loadSession(); }, [loadSession]);

  return { session, space, lines, setLines, serverState, setServerState, error, setError, loadSession };
}

interface ViewFlags {
  effectiveState: SessionState;
  recorderBusy: boolean;
  finalized: boolean;
  canEdit: boolean;
  isAdmin: boolean;
}

function computeFlags(args: {
  session: SessionPayload;
  serverState: SessionState | null;
  recorder: RecorderApi;
  spaceRole: SpacePayload["memberRole"] | null;
  auth: AuthState;
}): ViewFlags {
  const effectiveState = args.serverState ?? args.session.state;
  const isAdmin = adminFlag(args.auth);
  return {
    effectiveState,
    recorderBusy: recorderIsBusy(args.recorder),
    finalized: effectiveState === "finalized",
    canEdit: canEditFromRole(args.spaceRole) || isAdmin,
    isAdmin,
  };
}

function recorderIsBusy(recorder: RecorderApi): boolean {
  if (recorder.state !== "error") return false;
  return recorder.errorMessage?.startsWith("recorder_busy:") === true;
}

function RecorderArea({
  flags,
  recorder,
}: {
  flags: ViewFlags;
  recorder: RecorderApi;
}) {
  if (flags.recorderBusy) {
    return (
      <div className="scribe-error">
        Another client is recording this session.{" "}
        <button className="secondary" onClick={() => window.location.reload()}>Refresh</button>
      </div>
    );
  }
  if (flags.finalized || !flags.canEdit) return null;
  return (
    <div className="scribe-row" style={{ margin: "0.6rem 0" }}>
      <RecorderControls recorder={recorder} />
    </div>
  );
}

function SessionDetail() {
  const { slug, sessionId } = useParams({ from: "/spaces/$slug/sessions/$sessionId" });
  const auth = useAuth();
  const data = useSessionData(sessionId, slug);
  const { setLines, setServerState } = data;
  const [partial, setPartial] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLine = useCallback(
    (evt: LineEvent) => {
      setLines((prev) => new Map(prev).set(evt.id, evt));
      setPartial(null);
    },
    [setLines],
  );
  const onLineUpdated = useCallback(
    (evt: LineEvent) => {
      setLines((prev) => new Map(prev).set(evt.id, evt));
    },
    [setLines],
  );
  const onPartial = useCallback((evt: PartialEvent) => setPartial(evt.text), []);
  const onState = useCallback(
    (evt: StateEvent) => setServerState(evt.state),
    [setServerState],
  );

  const recorder = useRecorder({ sessionId, onLine, onLineUpdated, onPartial, onState });

  async function withBusy(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      data.setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const finalize = () =>
    withBusy(async () => {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/finalize`);
      await data.loadSession();
    });
  const unfinalize = () =>
    withBusy(async () => {
      await api.post(`/api/sessions/${encodeURIComponent(sessionId)}/unfinalize`);
      await data.loadSession();
    });

  if (data.error) return <div className="scribe-error">{data.error}</div>;
  if (!data.session) return <p className="scribe-empty">loading</p>;

  const flags = computeFlags({
    session: data.session,
    serverState: data.serverState,
    recorder,
    spaceRole: data.space?.memberRole ?? null,
    auth,
  });
  const transcriptLines = Array.from(data.lines.values()).map(toTranscriptLine);

  return (
    <>
      <SessionHeader
        slug={slug}
        session={data.session}
        effectiveState={flags.effectiveState}
        canEdit={flags.canEdit}
        isAdmin={flags.isAdmin}
        busy={busy}
        onFinalize={() => void finalize()}
        onUnfinalize={() => void unfinalize()}
      />
      <RecorderArea flags={flags} recorder={recorder} />
      <TranscriptView
        spaceSlug={slug}
        sessionId={sessionId}
        lines={transcriptLines}
        partial={partial}
        finalized={flags.finalized}
        canEdit={flags.canEdit}
      />
    </>
  );
}

function adminFlag(auth: AuthState): boolean {
  return auth.user?.groups.includes("admin") ?? false;
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/spaces/$slug/sessions/$sessionId",
  component: SessionDetail,
});
