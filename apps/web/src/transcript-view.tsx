import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, ApiError } from "./api";
import { formatMs, groupConsecutive, type LineGroup, type TranscriptLineLike } from "./transcript-utils";

export interface TranscriptLine extends TranscriptLineLike {
  start_ms: number;
  end_ms: number;
  text: string;
}

interface Speaker {
  id: string;
  name: string;
}

interface Props {
  spaceSlug: string;
  sessionId: string;
  lines: TranscriptLine[];
  partial: string | null;
  finalized: boolean;
  canEdit: boolean;
}

interface PopoverState {
  kind: "group" | "line";
  rawLabel: string;
  lineId: string | null;
  hasOverride: boolean;
}

function GroupHeader({
  group,
  canEdit,
  finalized,
  onOpen,
}: {
  group: LineGroup<TranscriptLine>;
  canEdit: boolean;
  finalized: boolean;
  onOpen: () => void;
}) {
  const interactive = canEdit && !finalized;
  return (
    <div
      className="scribe-line__speaker"
      style={{ padding: "0.2rem 0.6rem", cursor: interactive ? "pointer" : "default" }}
      onClick={interactive ? onOpen : undefined}
      title={interactive ? "Click to assign this speaker" : undefined}
    >
      {group.resolved}
    </div>
  );
}

function LineRow({
  line,
  interactive,
  onOpen,
}: {
  line: TranscriptLine;
  interactive: boolean;
  onOpen: () => void;
}) {
  const style: CSSProperties | undefined = interactive ? { cursor: "pointer" } : undefined;
  return (
    <div className="scribe-line" onClick={interactive ? onOpen : undefined} style={style}>
      <div className="scribe-line__ts">{formatMs(line.start_ms)}</div>
      <div className="scribe-line__speaker"></div>
      <div className="scribe-line__text">{line.text}</div>
    </div>
  );
}

export function TranscriptView({
  spaceSlug,
  sessionId,
  lines,
  partial,
  finalized,
  canEdit,
}: Props) {
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSpeakers = useCallback(async () => {
    try {
      const data = await api.get<Speaker[]>(`/api/spaces/${encodeURIComponent(spaceSlug)}/speakers`);
      setSpeakers(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }, [spaceSlug]);

  useEffect(() => {
    void loadSpeakers();
  }, [loadSpeakers]);

  const sorted = useMemo(() => [...lines].sort((a, b) => a.line_index - b.line_index), [lines]);
  const groups = useMemo(() => groupConsecutive(sorted), [sorted]);

  const interactive = canEdit && !finalized;

  if (groups.length === 0 && partial === null) {
    return (
      <div className="scribe-transcript">
        {error && <div className="scribe-error">{error}</div>}
        <p className="scribe-empty">No lines yet.</p>
      </div>
    );
  }

  return (
    <div className="scribe-transcript">
      {error && <div className="scribe-error">{error}</div>}
      {groups.map((group) => (
        <div key={`${group.rawLabel}-${group.lines[0]!.id}`} style={{ marginBottom: "0.4rem" }}>
          <GroupHeader
            group={group}
            canEdit={canEdit}
            finalized={finalized}
            onOpen={() =>
              setPopover({ kind: "group", rawLabel: group.rawLabel, lineId: null, hasOverride: false })
            }
          />
          {group.lines.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              interactive={interactive}
              onOpen={() =>
                setPopover({
                  kind: "line",
                  rawLabel: line.raw_speaker_label,
                  lineId: line.id,
                  hasOverride: line.resolved_speaker !== line.raw_speaker_label,
                })
              }
            />
          ))}
        </div>
      ))}
      {partial && (
        <div className="scribe-line" style={{ opacity: 0.6 }}>
          <div className="scribe-line__ts"></div>
          <div className="scribe-line__speaker">...</div>
          <div className="scribe-line__text">{partial}</div>
        </div>
      )}
      {popover && (
        <AssignPopover
          spaceSlug={spaceSlug}
          sessionId={sessionId}
          state={popover}
          speakers={speakers}
          onClose={() => setPopover(null)}
          onSpeakersChanged={async () => {
            await loadSpeakers();
          }}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  spaceSlug: string;
  sessionId: string;
  state: PopoverState;
  speakers: Speaker[];
  onClose: () => void;
  onSpeakersChanged: () => Promise<void>;
}

type Tier = "space" | "session" | "line";

function tierUrl(tier: Tier, params: { slug: string; sessionId: string; lineId: string | null; rawLabel: string }): string {
  switch (tier) {
    case "space":
      return `/api/spaces/${encodeURIComponent(params.slug)}/speaker-mappings/${encodeURIComponent(params.rawLabel)}`;
    case "session":
      return `/api/sessions/${encodeURIComponent(params.sessionId)}/speaker-mappings/${encodeURIComponent(params.rawLabel)}`;
    case "line":
      return `/api/lines/${encodeURIComponent(params.lineId!)}/speaker`;
  }
}

function AssignPopover({ spaceSlug, sessionId, state, speakers, onClose, onSpeakersChanged }: PopoverProps) {
  const [selectedId, setSelectedId] = useState<string>(speakers[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ensureSpeakerId(): Promise<string | null> {
    if (newName.trim()) {
      try {
        const created = await api.post<Speaker>(
          `/api/spaces/${encodeURIComponent(spaceSlug)}/speakers`,
          { name: newName.trim() },
        );
        await onSpeakersChanged();
        return created.id;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
        return null;
      }
    }
    if (!selectedId) {
      setError("Pick a speaker or enter a new name.");
      return null;
    }
    return selectedId;
  }

  async function apply(tier: Tier) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const speakerId = await ensureSpeakerId();
    if (!speakerId) {
      setBusy(false);
      return;
    }
    try {
      await api.put(
        tierUrl(tier, { slug: spaceSlug, sessionId, lineId: state.lineId, rawLabel: state.rawLabel }),
        { speaker_id: speakerId },
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearLineOverride() {
    if (busy || !state.lineId) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/lines/${encodeURIComponent(state.lineId)}/speaker`, { speaker_id: null });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scribe-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="scribe-modal__body" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>
          {state.kind === "group" ? "Assign speaker" : "Override speaker"}
        </h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Label: <code>{state.rawLabel}</code>
        </p>
        <label>
          existing speaker
          <select value={selectedId} onChange={(e) => setSelectedId(e.currentTarget.value)}>
            {speakers.length === 0 && <option value="">(none yet)</option>}
            {speakers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label>
          or create new
          <input
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            placeholder="e.g. Justin"
          />
        </label>
        {error && <div className="scribe-error">{error}</div>}
        <div className="scribe-row" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
          {state.kind === "group" ? (
            <>
              <button onClick={() => apply("space")} disabled={busy}>For this space</button>
              <button className="secondary" onClick={() => apply("session")} disabled={busy}>For this session only</button>
            </>
          ) : (
            <>
              <button onClick={() => apply("line")} disabled={busy}>Use for this line</button>
              {state.hasOverride && (
                <button className="secondary" onClick={clearLineOverride} disabled={busy}>
                  Clear override
                </button>
              )}
            </>
          )}
          <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
