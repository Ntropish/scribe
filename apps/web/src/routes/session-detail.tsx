import { Link, createRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Pause, Play, Square } from "lucide-react";
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
import { useAutoScroll } from "../use-auto-scroll";

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
  name: string;
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

interface ActionMenuItem {
  label: string;
  onClick: () => void;
}

function ActionMenu({ items, busy }: { items: ActionMenuItem[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="scribe-action-menu" ref={wrapperRef}>
      <button
        type="button"
        className="scribe-action-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Session actions"
        onClick={() => setOpen((v) => !v)}
      >
        &#x22EE;
      </button>
      {open && (
        <div role="menu" className="scribe-action-menu__menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordButton({
  onClick,
  disabled,
  hint,
}: {
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      className="scribe-record-btn"
      aria-label={hint ?? "Record"}
      title={hint ?? "Record"}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="scribe-record-btn__dot" />
    </button>
  );
}

function IconButton({
  label,
  onClick,
  icon,
  variant,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const cls = variant === "secondary"
    ? "scribe-icon-btn scribe-icon-btn--secondary"
    : "scribe-icon-btn";
  return (
    <button type="button" className={cls} aria-label={label} title={label} onClick={onClick}>
      {icon}
    </button>
  );
}

function RecorderControls({ recorder }: { recorder: RecorderApi }) {
  if (recorder.state === "idle") {
    return <RecordButton onClick={() => void recorder.start()} />;
  }
  if (recorder.state === "requesting_mic") {
    return <RecordButton onClick={() => {}} disabled hint="Requesting mic" />;
  }
  if (recorder.state === "connecting") {
    return <RecordButton onClick={() => {}} disabled hint="Connecting to transcription service" />;
  }
  if (recorder.state === "recording") {
    return (
      <>
        <IconButton label="Pause" onClick={recorder.pause} icon={<Pause size={16} />} variant="secondary" />
        <IconButton label="Stop" onClick={() => void recorder.stop()} icon={<Square size={16} fill="currentColor" />} variant="secondary" />
        <span className="scribe-recorder-indicator scribe-recorder-indicator--recording">recording</span>
      </>
    );
  }
  if (recorder.state === "paused") {
    return (
      <>
        <IconButton label="Resume" onClick={recorder.resume} icon={<Play size={16} fill="currentColor" />} />
        <IconButton label="Stop" onClick={() => void recorder.stop()} icon={<Square size={16} fill="currentColor" />} variant="secondary" />
        <span className="scribe-recorder-indicator scribe-recorder-indicator--paused">paused</span>
      </>
    );
  }
  if (recorder.state === "stopping") {
    return <span className="scribe-recorder-indicator">stopping</span>;
  }
  if (recorder.state === "error") {
    return (
      <>
        <RecordButton onClick={() => void recorder.start()} hint="Retry recording" />
        {recorder.errorMessage && (
          <span className="scribe-error scribe-error--inline">{recorder.errorMessage}</span>
        )}
      </>
    );
  }
  return null;
}

function SessionHeader({
  slug,
  spaceName,
  session,
  effectiveState,
  busy,
  recorder,
  showRecorder,
  recorderBusy,
  actionItems,
}: {
  slug: string;
  spaceName: string | null;
  session: SessionPayload;
  effectiveState: SessionState;
  busy: boolean;
  recorder: RecorderApi;
  showRecorder: boolean;
  recorderBusy: boolean;
  actionItems: ActionMenuItem[];
}) {
  const finalized = effectiveState === "finalized";
  const finalizedAtLabel = finalized && session.finalizedAt
    ? `Finalized ${new Date(session.finalizedAt).toLocaleString()}`
    : `Started ${new Date(session.startedAt).toLocaleString()}`;
  return (
    <div className="scribe-session__header">
      <Link
        to="/spaces/$slug"
        params={{ slug }}
        className="scribe-session__back"
        aria-label={spaceName ? `Back to ${spaceName}` : "Back"}
      >
        <ChevronLeft size={16} />
        <span>{spaceName ?? "Back"}</span>
      </Link>
      <div className="scribe-session__title">
        <h1>{session.title || "(untitled)"}</h1>
        <span className={`scribe-state scribe-state--${effectiveState}`}>{effectiveState}</span>
        <span className="scribe-session__meta">{finalizedAtLabel}</span>
      </div>
      {showRecorder && !recorderBusy && (
        <div className="scribe-session__recorder">
          <RecorderControls recorder={recorder} />
        </div>
      )}
      <ActionMenu items={actionItems} busy={busy} />
    </div>
  );
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

function FinalizeModal({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="scribe-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finalize-modal-title"
      onClick={onCancel}
    >
      <div className="scribe-modal__body" onClick={(e) => e.stopPropagation()}>
        <h2 id="finalize-modal-title" style={{ margin: 0 }}>Finalize this session?</h2>
        <p style={{ margin: 0 }}>
          Once finalized, no one can edit lines, speaker mappings, or the session title.
          An admin can unfinalize the session if needed.
        </p>
        <div className="scribe-row" style={{ justifyContent: "flex-end" }}>
          <button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button onClick={onConfirm} disabled={busy}>
            {busy ? "Finalizing..." : "Finalize"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecorderBusyBanner() {
  return (
    <div className="scribe-error">
      Another client is recording this session.{" "}
      <button className="secondary" onClick={() => window.location.reload()}>Refresh</button>
    </div>
  );
}

function RenameModal({
  initialTitle,
  busy,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const trimmed = title.trim();
  const canSubmit = !busy && trimmed.length > 0 && trimmed !== initialTitle.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSubmit) onSubmit(trimmed);
  }

  return (
    <div
      className="scribe-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-modal-title"
      onClick={onCancel}
    >
      <form
        className="scribe-modal__body"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2 id="rename-modal-title" style={{ margin: 0 }}>Rename session</h2>
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            autoFocus
            maxLength={500}
          />
        </label>
        <div className="scribe-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" disabled={!canSubmit}>
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function useRecorderCallbacks(
  setLines: (updater: (prev: Map<string, Line>) => Map<string, Line>) => void,
  setPartial: (text: string | null) => void,
  setServerState: (state: SessionState) => void,
) {
  const onLine = useCallback(
    (evt: LineEvent) => {
      setLines((prev) => new Map(prev).set(evt.id, evt));
      setPartial(null);
    },
    [setLines, setPartial],
  );
  const onLineUpdated = useCallback(
    (evt: LineEvent) => {
      setLines((prev) => new Map(prev).set(evt.id, evt));
    },
    [setLines],
  );
  const onPartial = useCallback((evt: PartialEvent) => setPartial(evt.text), [setPartial]);
  const onState = useCallback(
    (evt: StateEvent) => setServerState(evt.state),
    [setServerState],
  );
  return { onLine, onLineUpdated, onPartial, onState };
}

interface SessionMutations {
  busy: boolean;
  confirmFinalize: () => Promise<void>;
  unfinalize: () => Promise<void>;
  submitRename: (title: string) => Promise<void>;
}

function useSessionMutations(args: {
  sessionId: string;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  onFinalized: () => void;
  onRenamed: () => void;
}): SessionMutations {
  const [busy, setBusy] = useState(false);
  const withBusy = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      args.onError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    confirmFinalize: () =>
      withBusy(async () => {
        await api.post(`/api/sessions/${encodeURIComponent(args.sessionId)}/finalize`);
        await args.reload();
        args.onFinalized();
      }),
    unfinalize: () =>
      withBusy(async () => {
        await api.post(`/api/sessions/${encodeURIComponent(args.sessionId)}/unfinalize`);
        await args.reload();
      }),
    submitRename: (title: string) =>
      withBusy(async () => {
        await api.patch(`/api/sessions/${encodeURIComponent(args.sessionId)}`, { title });
        await args.reload();
        args.onRenamed();
      }),
  };
}

function buildActionItems(args: {
  flags: ViewFlags;
  onRename: () => void;
  onFinalize: () => void;
  onUnfinalize: () => void;
}): ActionMenuItem[] {
  const items: ActionMenuItem[] = [];
  if (args.flags.canEdit && !args.flags.finalized) {
    items.push({ label: "Rename", onClick: args.onRename });
    items.push({ label: "Finalize", onClick: args.onFinalize });
  }
  if (args.flags.finalized && args.flags.isAdmin) {
    items.push({ label: "Unfinalize", onClick: args.onUnfinalize });
  }
  return items;
}

function TranscriptArea({
  scrollRef,
  follow,
  onActivateFollow,
  spaceSlug,
  sessionId,
  lines,
  partial,
  finalized,
  canEdit,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  follow: boolean;
  onActivateFollow: () => void;
  spaceSlug: string;
  sessionId: string;
  lines: TranscriptLine[];
  partial: string | null;
  finalized: boolean;
  canEdit: boolean;
}) {
  return (
    <div className="scribe-session__transcript-area">
      <div className="scribe-session__transcript-scroll" ref={scrollRef}>
        <TranscriptView
          spaceSlug={spaceSlug}
          sessionId={sessionId}
          lines={lines}
          partial={partial}
          finalized={finalized}
          canEdit={canEdit}
        />
      </div>
      <button
        type="button"
        className={follow ? "scribe-follow-pill scribe-follow-pill--on" : "scribe-follow-pill"}
        onClick={onActivateFollow}
        aria-pressed={follow}
      >
        {follow ? "Following" : "Follow latest"}
      </button>
    </div>
  );
}

function SessionModals({
  finalizeOpen,
  renameOpen,
  busy,
  initialTitle,
  onCancelFinalize,
  onConfirmFinalize,
  onCancelRename,
  onSubmitRename,
}: {
  finalizeOpen: boolean;
  renameOpen: boolean;
  busy: boolean;
  initialTitle: string;
  onCancelFinalize: () => void;
  onConfirmFinalize: () => void;
  onCancelRename: () => void;
  onSubmitRename: (title: string) => void;
}) {
  return (
    <>
      {finalizeOpen && (
        <FinalizeModal busy={busy} onCancel={onCancelFinalize} onConfirm={onConfirmFinalize} />
      )}
      {renameOpen && (
        <RenameModal
          initialTitle={initialTitle}
          busy={busy}
          onCancel={onCancelRename}
          onSubmit={onSubmitRename}
        />
      )}
    </>
  );
}

function SessionDetail() {
  const { slug, sessionId } = useParams({ from: "/spaces/$slug/sessions/$sessionId" });
  const auth = useAuth();
  const data = useSessionData(sessionId, slug);
  const [partial, setPartial] = useState<string | null>(null);
  const [finalizeRequested, setFinalizeRequested] = useState(false);
  const [renameRequested, setRenameRequested] = useState(false);

  const callbacks = useRecorderCallbacks(data.setLines, setPartial, data.setServerState);
  const recorder = useRecorder({ sessionId, ...callbacks });

  const mutations = useSessionMutations({
    sessionId,
    reload: data.loadSession,
    onError: data.setError,
    onFinalized: () => setFinalizeRequested(false),
    onRenamed: () => setRenameRequested(false),
  });

  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const followTrigger = `${data.lines.size}:${partial ? partial.length : 0}`;
  const autoScroll = useAutoScroll(transcriptScrollRef, followTrigger);

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
  const actionItems = buildActionItems({
    flags,
    onRename: () => setRenameRequested(true),
    onFinalize: () => setFinalizeRequested(true),
    onUnfinalize: () => void mutations.unfinalize(),
  });

  return (
    <div className="scribe-session">
      <SessionHeader
        slug={slug}
        spaceName={data.space?.name ?? null}
        session={data.session}
        effectiveState={flags.effectiveState}
        busy={mutations.busy}
        recorder={recorder}
        showRecorder={flags.canEdit && !flags.finalized}
        recorderBusy={flags.recorderBusy}
        actionItems={actionItems}
      />
      {flags.recorderBusy && <RecorderBusyBanner />}
      <TranscriptArea
        scrollRef={transcriptScrollRef}
        follow={autoScroll.follow}
        onActivateFollow={autoScroll.activate}
        spaceSlug={slug}
        sessionId={sessionId}
        lines={transcriptLines}
        partial={partial}
        finalized={flags.finalized}
        canEdit={flags.canEdit}
      />
      <SessionModals
        finalizeOpen={finalizeRequested}
        renameOpen={renameRequested}
        busy={mutations.busy}
        initialTitle={data.session.title}
        onCancelFinalize={() => setFinalizeRequested(false)}
        onConfirmFinalize={() => void mutations.confirmFinalize()}
        onCancelRename={() => setRenameRequested(false)}
        onSubmitRename={(title) => void mutations.submitRename(title)}
      />
    </div>
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
