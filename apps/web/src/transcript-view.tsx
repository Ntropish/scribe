import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, ApiError } from "./api";

export interface TranscriptLine {
  id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  raw_speaker_label: string;
  resolved_speaker: string;
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

interface LineGroup {
  rawLabel: string;
  resolved: string;
  lines: TranscriptLine[];
}

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function groupConsecutive(lines: TranscriptLine[]): LineGroup[] {
  const groups: LineGroup[] = [];
  for (const line of lines) {
    const tail = groups[groups.length - 1];
    if (tail && tail.rawLabel === line.raw_speaker_label) {
      tail.lines.push(line);
      tail.resolved = line.resolved_speaker;
    } else {
      groups.push({
        rawLabel: line.raw_speaker_label,
        resolved: line.resolved_speaker,
        lines: [line],
      });
    }
  }
  return groups;
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

  async function loadSpeakers() {
    try {
      const data = await api.get<Speaker[]>(`/api/spaces/${encodeURIComponent(spaceSlug)}/speakers`);
      setSpeakers(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    }
  }

  useEffect(() => {
    void loadSpeakers();
  }, [spaceSlug]);

  const sorted = useMemo(() => [...lines].sort((a, b) => a.line_index - b.line_index), [lines]);
  const groups = useMemo(() => groupConsecutive(sorted), [sorted]);

  function openLine(line: TranscriptLine) {
    if (!canEdit || finalized) return;
    setPopover({
      kind: "line",
      rawLabel: line.raw_speaker_label,
      lineId: line.id,
      hasOverride: line.resolved_speaker !== line.raw_speaker_label,
    });
  }

  function openGroup(group: LineGroup) {
    if (!canEdit || finalized) return;
    setPopover({ kind: "group", rawLabel: group.rawLabel, lineId: null, hasOverride: false });
  }

  return (
    <div className="scribe-transcript">
      {error && <div className="scribe-error">{error}</div>}
      {groups.length === 0 && partial === null ? (
        <p className="scribe-empty">No lines yet.</p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={`${group.rawLabel}-${group.lines[0]!.id}`} style={{ marginBottom: "0.4rem" }}>
              <div
                className="scribe-line__speaker"
                style={{ padding: "0.2rem 0.6rem", cursor: canEdit && !finalized ? "pointer" : "default" }}
                onClick={() => openGroup(group)}
                title={canEdit && !finalized ? "Click to assign this speaker" : undefined}
              >
                {group.resolved}
                <span style={{ color: "var(--muted)", marginLeft: "0.4rem", fontWeight: "normal" }}>
                  ({group.rawLabel})
                </span>
              </div>
              {group.lines.map((line) => (
                <div
                  className="scribe-line"
                  key={line.id}
                  onClick={() => openLine(line)}
                  style={
                    canEdit && !finalized
                      ? ({ cursor: "pointer" } as CSSProperties)
                      : undefined
                  }
                >
                  <div className="scribe-line__ts">{formatMs(line.start_ms)}</div>
                  <div className="scribe-line__speaker">{line.resolved_speaker}</div>
                  <div>{line.text}</div>
                </div>
              ))}
            </div>
          ))}
          {partial && (
            <div className="scribe-line" style={{ opacity: 0.6 }}>
              <div className="scribe-line__ts"></div>
              <div className="scribe-line__speaker">...</div>
              <div>{partial}</div>
            </div>
          )}
        </>
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

function AssignPopover({
  spaceSlug,
  sessionId,
  state,
  speakers,
  onClose,
  onSpeakersChanged,
}: PopoverProps) {
  const [selectedId, setSelectedId] = useState<string>(speakers[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ensureSpeaker(): Promise<string | null> {
    if (newName.trim()) {
      try {
        const created = await api.post<Speaker>(
          `/api/spaces/${encodeURIComponent(spaceSlug)}/speakers`,
          { name: newName.trim() },
        );
        await onSpeakersChanged();
        return created.id;
      } catch (err) {
        if (err instanceof ApiError) setError(err.message);
        else setError(String(err));
        return null;
      }
    }
    if (!selectedId) {
      setError("Pick a speaker or enter a new name.");
      return null;
    }
    return selectedId;
  }

  async function applySpace() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const speakerId = await ensureSpeaker();
    if (!speakerId) {
      setBusy(false);
      return;
    }
    try {
      await api.put(
        `/api/spaces/${encodeURIComponent(spaceSlug)}/speaker-mappings/${encodeURIComponent(state.rawLabel)}`,
        { speaker_id: speakerId },
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applySession() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const speakerId = await ensureSpeaker();
    if (!speakerId) {
      setBusy(false);
      return;
    }
    try {
      await api.put(
        `/api/sessions/${encodeURIComponent(sessionId)}/speaker-mappings/${encodeURIComponent(state.rawLabel)}`,
        { speaker_id: speakerId },
      );
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyLine() {
    if (busy || !state.lineId) return;
    setBusy(true);
    setError(null);
    const speakerId = await ensureSpeaker();
    if (!speakerId) {
      setBusy(false);
      return;
    }
    try {
      await api.put(`/api/lines/${encodeURIComponent(state.lineId)}/speaker`, { speaker_id: speakerId });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
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
      if (err instanceof ApiError) setError(err.message);
      else setError(String(err));
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
              <button onClick={applySpace} disabled={busy}>For this space</button>
              <button className="secondary" onClick={applySession} disabled={busy}>For this session only</button>
            </>
          ) : (
            <>
              <button onClick={applyLine} disabled={busy}>Use for this line</button>
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
