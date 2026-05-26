import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import WebSocket from "ws";
import { z } from "zod";
import { env } from "./env";
import { getPostgresClient } from "./infrastructure";
import { getSession, getUser } from "./db";
import {
  effectiveSpaceRole,
  loadSpaceById,
  meetsRole,
  type SpaceCore,
} from "./space-acl";
import type { AuthContext } from "./middleware";

interface SocketData {
  auth: AuthContext;
  sessionId: string | null;
}

type AckFn = (resp: unknown) => void;

interface ClientToServerEvents {
  join: (payload: unknown, ack?: AckFn) => void;
  start: (payload: unknown, ack?: AckFn) => void;
  audio: (buf: Buffer | ArrayBuffer) => void;
  pause: (payload: unknown, ack?: AckFn) => void;
  resume: (payload: unknown, ack?: AckFn) => void;
  stop: (payload: unknown, ack?: AckFn) => void;
}

interface ServerStateEvent {
  session_id: string;
  state: "recording" | "paused" | "stopped" | "finalized";
  is_audio_flowing: boolean;
  recorder_socket_id: string | null;
}

interface ServerLineEvent {
  id: string;
  session_id: string;
  capture_id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  raw_speaker_label: string;
  resolved_speaker: string;
  created_at: string;
}

interface ServerToClientEvents {
  state: (payload: ServerStateEvent) => void;
  partial: (payload: { text: string; capture_id: string }) => void;
  line: (payload: ServerLineEvent) => void;
  error: (payload: { code: string; message: string }) => void;
}

type IO = SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ServerSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

interface SessionDbRow {
  id: string;
  space_id: string;
  state: "recording" | "paused" | "stopped" | "finalized";
}

interface CaptureState {
  io: IO;
  sessionId: string;
  spaceId: string;
  spaceSlug: string;
  recorderSocketId: string;
  serviceWs: WebSocket;
  captureId: string;
  captureStartedAt: number;
  forwardingAudio: boolean;
  nextLineIndex: number;
}

// Per-session in-process state. Only one capture (== one service WS) at a
// time; a second client trying to start hits recorder_busy.
const activeCaptures = new Map<string, CaptureState>();

const joinSchema = z.object({ session_id: z.string().uuid() });
const startSchema = z.object({
  session_id: z.string().uuid(),
  language: z.string().min(1).max(8).optional(),
});

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function resolveAuthFromSocket(
  socket: ServerSocket,
): Promise<AuthContext | null> {
  if (env.authDisabled) {
    return {
      type: "user",
      userId: "__bypass__",
      subject: "__bypass__",
      username: "anonymous",
      groups: ["admin"],
      managedAgents: [],
    };
  }
  const cookieHeader = socket.handshake.headers.cookie;
  const sessionId = readCookie(cookieHeader, "scribe_session");
  if (!sessionId) return null;
  const session = await getSession(sessionId);
  if (!session) return null;
  const user = await getUser(session.userId);
  if (!user) return null;
  return {
    type: "user",
    userId: user.id,
    subject: user.oidcSub,
    username: user.username,
    groups: session.groups,
    managedAgents: session.managedAgents,
  };
}

async function loadSession(id: string): Promise<SessionDbRow | null> {
  const sql = getPostgresClient();
  const rows = await sql<SessionDbRow[]>`
    SELECT id, space_id, state
    FROM sessions WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

async function loadSpaceForSession(
  sessionId: string,
): Promise<{ session: SessionDbRow; space: SpaceCore } | null> {
  const session = await loadSession(sessionId);
  if (!session) return null;
  const space = await loadSpaceById(session.space_id);
  if (!space || space.archivedAt) return null;
  return { session, space };
}

async function emitError(
  socket: ServerSocket,
  code: string,
  message: string,
): Promise<void> {
  socket.emit("error", { code, message });
}

function emitState(io: IO, sessionId: string, partial: {
  state: SessionDbRow["state"];
  recorderSocketId: string | null;
  isAudioFlowing: boolean;
}): void {
  io.to(`session:${sessionId}`).emit("state", {
    session_id: sessionId,
    state: partial.state,
    is_audio_flowing: partial.isAudioFlowing,
    recorder_socket_id: partial.recorderSocketId,
  });
}

async function setSessionState(
  sessionId: string,
  state: SessionDbRow["state"],
): Promise<void> {
  const sql = getPostgresClient();
  await sql`
    UPDATE sessions SET state = ${state}, updated_at = now() WHERE id = ${sessionId}
  `;
}

async function createCaptureRow(sessionId: string): Promise<{ id: string; startedAtMs: number }> {
  const sql = getPostgresClient();
  const rows = await sql<{ id: string; capture_index: number; started_at: string }[]>`
    WITH next AS (
      SELECT COALESCE(MAX(capture_index), -1) + 1 AS idx
      FROM captures WHERE session_id = ${sessionId}
    )
    INSERT INTO captures (session_id, capture_index)
    SELECT ${sessionId}, idx FROM next
    RETURNING id, capture_index, started_at
  `;
  const row = rows[0];
  if (!row) throw new Error("createCaptureRow returned no row");
  return { id: row.id, startedAtMs: new Date(row.started_at).getTime() };
}

async function nextLineIndex(sessionId: string): Promise<number> {
  const sql = getPostgresClient();
  const rows = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(line_index), -1) + 1 AS next
    FROM lines WHERE session_id = ${sessionId}
  `;
  return rows[0]?.next ?? 0;
}

interface FinalFrame {
  type: "final";
  text: string;
  audio_s: number;
  latency_ms?: number;
  speaker?: string;
  embedding?: number[];
}

interface PartialFrame {
  type: "partial";
  text: string;
  audio_s?: number;
  latency_ms?: number;
}

type ServiceFrame = FinalFrame | PartialFrame | { type: string; [key: string]: unknown };

async function insertLine(
  capture: CaptureState,
  frame: FinalFrame,
): Promise<{
  id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  raw_speaker_label: string;
  created_at: string;
}> {
  const sql = getPostgresClient();
  // The service's `audio_s` is utterance length, so we approximate the
  // utterance window from the capture's wall-clock anchor.
  const endMs = Date.now() - capture.captureStartedAt;
  const startMs = Math.max(0, endMs - Math.round(frame.audio_s * 1000));
  const lineIndex = capture.nextLineIndex;
  const speakerLabel = frame.speaker ?? "Speaker 1";
  const rows = await sql<{
    id: string;
    line_index: number;
    start_ms: number;
    end_ms: number;
    text: string;
    raw_speaker_label: string;
    created_at: string;
  }[]>`
    INSERT INTO lines (
      session_id, capture_id, line_index,
      start_ms, end_ms, text, raw_speaker_label, embedding
    )
    VALUES (
      ${capture.sessionId}, ${capture.captureId}, ${lineIndex},
      ${startMs}, ${endMs}, ${frame.text}, ${speakerLabel},
      ${frame.embedding ?? null}
    )
    RETURNING id, line_index, start_ms, end_ms, text, raw_speaker_label, created_at
  `;
  const row = rows[0];
  if (!row) throw new Error("insertLine returned no row");
  capture.nextLineIndex = lineIndex + 1;
  return row;
}

function teardownCapture(state: CaptureState, reason: "stop" | "service_error"): void {
  try {
    state.serviceWs.close();
  } catch {
    // ignore
  }
  const sql = getPostgresClient();
  void sql`
    UPDATE captures SET ended_at = now() WHERE id = ${state.captureId}
  `.catch(() => {});
  activeCaptures.delete(state.sessionId);
  if (reason === "service_error") {
    state.io.to(`session:${state.sessionId}`).emit("error", {
      code: "service_unavailable",
      message: "whisper-stream connection ended unexpectedly",
    });
  }
}

function attachServiceListeners(state: CaptureState): void {
  state.serviceWs.on("message", async (raw, isBinary) => {
    if (isBinary) return; // service never sends binary back
    let frame: ServiceFrame;
    try {
      frame = JSON.parse(raw.toString()) as ServiceFrame;
    } catch {
      return;
    }
    if (frame.type === "partial") {
      state.io.to(`session:${state.sessionId}`).emit("partial", {
        text: (frame as PartialFrame).text,
        capture_id: state.captureId,
      });
      return;
    }
    if (frame.type === "final") {
      try {
        const row = await insertLine(state, frame as FinalFrame);
        state.io.to(`session:${state.sessionId}`).emit("line", {
          id: row.id,
          session_id: state.sessionId,
          capture_id: state.captureId,
          line_index: row.line_index,
          start_ms: row.start_ms,
          end_ms: row.end_ms,
          text: row.text,
          raw_speaker_label: row.raw_speaker_label,
          resolved_speaker: row.raw_speaker_label,
          created_at: row.created_at,
        });
      } catch (err) {
        console.error("[scribe] failed to write line:", err);
      }
      return;
    }
    // ready / unknown: ignore
  });

  state.serviceWs.on("close", () => {
    if (activeCaptures.get(state.sessionId) === state) {
      teardownCapture(state, "service_error");
      void setSessionState(state.sessionId, "stopped").catch(() => {});
      emitState(state.io, state.sessionId, {
        state: "stopped",
        recorderSocketId: null,
        isAudioFlowing: false,
      });
    }
  });

  state.serviceWs.on("error", (err) => {
    console.error("[scribe] whisper-stream socket error:", err);
  });
}

export function attachSocketIO(httpServer: HttpServer): IO {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.publicOrigin || true, credentials: true },
  }) as IO;

  io.use(async (socket, next) => {
    const auth = await resolveAuthFromSocket(socket as ServerSocket);
    if (!auth) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.auth = auth;
    socket.data.sessionId = null;
    next();
  });

  io.on("connection", (socket) => {
    socket.on("join", async (payload, ack?: (resp: unknown) => void) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        await emitError(socket, "invalid_payload", "join payload must be { session_id }");
        ack?.({ ok: false });
        return;
      }
      const ctx = await loadSpaceForSession(parsed.data.session_id);
      if (!ctx) {
        await emitError(socket, "not_found", "session not found");
        ack?.({ ok: false });
        return;
      }
      const role = await effectiveSpaceRole(ctx.space, socket.data.auth);
      if (!meetsRole(role, "viewer") && ctx.space.visibility !== "public") {
        await emitError(socket, "not_authorized", "no access to this space");
        ack?.({ ok: false });
        return;
      }
      socket.data.sessionId = ctx.session.id;
      await socket.join(`session:${ctx.session.id}`);
      const capture = activeCaptures.get(ctx.session.id);
      emitState(io, ctx.session.id, {
        state: ctx.session.state,
        recorderSocketId: capture?.recorderSocketId ?? null,
        isAudioFlowing: capture?.forwardingAudio ?? false,
      });
      ack?.({ ok: true });
    });

    socket.on("start", async (payload, ack?: (resp: unknown) => void) => {
      const parsed = startSchema.safeParse(payload);
      if (!parsed.success) {
        await emitError(socket, "invalid_payload", "start payload must include session_id");
        ack?.({ ok: false });
        return;
      }
      const ctx = await loadSpaceForSession(parsed.data.session_id);
      if (!ctx) {
        await emitError(socket, "not_found", "session not found");
        ack?.({ ok: false });
        return;
      }
      if (ctx.session.state === "finalized") {
        await emitError(socket, "session_finalized", "session is finalized");
        ack?.({ ok: false });
        return;
      }
      const role = await effectiveSpaceRole(ctx.space, socket.data.auth);
      if (!meetsRole(role, "editor")) {
        await emitError(socket, "not_authorized", "editor role required to record");
        ack?.({ ok: false });
        return;
      }
      if (activeCaptures.has(ctx.session.id)) {
        await emitError(socket, "recorder_busy", "another client is recording this session");
        ack?.({ ok: false });
        return;
      }

      // Open the service WS first; only commit captures row if it opens cleanly.
      const ws = new WebSocket(env.whisperStreamUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", (err) => reject(err));
        });
      } catch (err) {
        console.error("[scribe] could not open whisper-stream WS:", err);
        await emitError(socket, "service_unavailable", "whisper-stream is unreachable");
        ack?.({ ok: false });
        return;
      }

      const startMsg = {
        type: "start" as const,
        ...(parsed.data.language ? { language: parsed.data.language } : {}),
        space_id: ctx.session.space_id,
      };
      ws.send(JSON.stringify(startMsg));

      const capture = await createCaptureRow(ctx.session.id);
      const nextIdx = await nextLineIndex(ctx.session.id);

      const state: CaptureState = {
        io,
        sessionId: ctx.session.id,
        spaceId: ctx.session.space_id,
        spaceSlug: ctx.space.slug,
        recorderSocketId: socket.id,
        serviceWs: ws,
        captureId: capture.id,
        captureStartedAt: capture.startedAtMs,
        forwardingAudio: true,
        nextLineIndex: nextIdx,
      };
      activeCaptures.set(ctx.session.id, state);
      attachServiceListeners(state);

      socket.data.sessionId = ctx.session.id;
      await socket.join(`session:${ctx.session.id}`);

      await setSessionState(ctx.session.id, "recording");
      emitState(io, ctx.session.id, {
        state: "recording",
        recorderSocketId: socket.id,
        isAudioFlowing: true,
      });
      ack?.({ ok: true, capture_id: capture.id });
    });

    socket.on("audio", (buf: ArrayBuffer | Buffer) => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;
      const state = activeCaptures.get(sessionId);
      if (!state || state.recorderSocketId !== socket.id) return;
      if (!state.forwardingAudio) return;
      if (state.serviceWs.readyState !== WebSocket.OPEN) return;
      state.serviceWs.send(buf as Buffer | ArrayBuffer);
    });

    socket.on("pause", async (_payload, ack?: (resp: unknown) => void) => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) {
        ack?.({ ok: false });
        return;
      }
      const state = activeCaptures.get(sessionId);
      if (!state || state.recorderSocketId !== socket.id) {
        ack?.({ ok: false });
        return;
      }
      state.forwardingAudio = false;
      await setSessionState(sessionId, "paused");
      emitState(io, sessionId, {
        state: "paused",
        recorderSocketId: state.recorderSocketId,
        isAudioFlowing: false,
      });
      ack?.({ ok: true });
    });

    socket.on("resume", async (_payload, ack?: (resp: unknown) => void) => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) {
        ack?.({ ok: false });
        return;
      }
      const state = activeCaptures.get(sessionId);
      if (!state || state.recorderSocketId !== socket.id) {
        ack?.({ ok: false });
        return;
      }
      state.forwardingAudio = true;
      await setSessionState(sessionId, "recording");
      emitState(io, sessionId, {
        state: "recording",
        recorderSocketId: state.recorderSocketId,
        isAudioFlowing: true,
      });
      ack?.({ ok: true });
    });

    async function stopRecording(reason: "stop" | "disconnect") {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;
      const state = activeCaptures.get(sessionId);
      if (!state || state.recorderSocketId !== socket.id) return;
      try {
        state.serviceWs.send(JSON.stringify({ type: "stop" }));
      } catch {
        // ignore
      }
      teardownCapture(state, "stop");
      await setSessionState(sessionId, "stopped");
      emitState(io, sessionId, {
        state: "stopped",
        recorderSocketId: null,
        isAudioFlowing: false,
      });
      void reason;
    }

    socket.on("stop", async (_payload, ack?: (resp: unknown) => void) => {
      await stopRecording("stop");
      ack?.({ ok: true });
    });

    socket.on("disconnect", async () => {
      await stopRecording("disconnect").catch((err) => {
        console.error("[scribe] error during disconnect cleanup:", err);
      });
    });
  });

  return io;
}
