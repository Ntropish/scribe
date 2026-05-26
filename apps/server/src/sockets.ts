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
import { loadResolvedLineById } from "./lines";

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
  line_updated: (payload: ServerLineEvent) => void;
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

const activeCaptures = new Map<string, CaptureState>();

let ioInstance: IO | null = null;

export function getIo(): IO | null {
  return ioInstance;
}

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
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function resolveAuthFromSocket(socket: ServerSocket): Promise<AuthContext | null> {
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
    SELECT id, space_id, state FROM sessions WHERE id = ${id}
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

function emitErr(socket: ServerSocket, code: string, message: string, ack?: AckFn) {
  socket.emit("error", { code, message });
  ack?.({ ok: false, error: code });
}

function emitState(
  io: IO,
  sessionId: string,
  state: SessionDbRow["state"],
  recorderSocketId: string | null,
  isAudioFlowing: boolean,
) {
  io.to(`session:${sessionId}`).emit("state", {
    session_id: sessionId,
    state,
    is_audio_flowing: isAudioFlowing,
    recorder_socket_id: recorderSocketId,
  });
}

async function setSessionState(sessionId: string, state: SessionDbRow["state"]): Promise<void> {
  const sql = getPostgresClient();
  await sql`UPDATE sessions SET state = ${state}, updated_at = now() WHERE id = ${sessionId}`;
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
  speaker?: string;
  embedding?: number[];
}

interface PartialFrame {
  type: "partial";
  text: string;
}

type ServiceFrame = FinalFrame | PartialFrame | { type: string };

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
  void sql`UPDATE captures SET ended_at = now() WHERE id = ${state.captureId}`.catch(() => {});
  activeCaptures.delete(state.sessionId);
  if (reason === "service_error") {
    state.io.to(`session:${state.sessionId}`).emit("error", {
      code: "service_unavailable",
      message: "whisper-stream connection ended unexpectedly",
    });
  }
}

async function handleFinalFrame(state: CaptureState, frame: FinalFrame) {
  try {
    const row = await insertLine(state, frame);
    const resolved = await loadResolvedLineById(row.id);
    const resolvedSpeaker = resolved?.resolvedSpeaker ?? row.raw_speaker_label;
    state.io.to(`session:${state.sessionId}`).emit("line", {
      id: row.id,
      session_id: state.sessionId,
      capture_id: state.captureId,
      line_index: row.line_index,
      start_ms: row.start_ms,
      end_ms: row.end_ms,
      text: row.text,
      raw_speaker_label: row.raw_speaker_label,
      resolved_speaker: resolvedSpeaker,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error("[scribe] failed to write line:", err);
  }
}

function attachServiceListeners(state: CaptureState): void {
  state.serviceWs.on("message", (raw, isBinary) => {
    if (isBinary) return;
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
    } else if (frame.type === "final") {
      void handleFinalFrame(state, frame as FinalFrame);
    }
  });

  state.serviceWs.on("close", () => {
    if (activeCaptures.get(state.sessionId) !== state) return;
    teardownCapture(state, "service_error");
    void setSessionState(state.sessionId, "stopped").catch(() => {});
    emitState(state.io, state.sessionId, "stopped", null, false);
  });

  state.serviceWs.on("error", (err) => {
    console.error("[scribe] whisper-stream socket error:", err);
  });
}

async function handleJoin(io: IO, socket: ServerSocket, payload: unknown, ack: AckFn | undefined) {
  const parsed = joinSchema.safeParse(payload);
  if (!parsed.success) {
    return emitErr(socket, "invalid_payload", "join payload must be { session_id }", ack);
  }
  const ctx = await loadSpaceForSession(parsed.data.session_id);
  if (!ctx) return emitErr(socket, "not_found", "session not found", ack);
  const role = await effectiveSpaceRole(ctx.space, socket.data.auth);
  if (!meetsRole(role, "viewer") && ctx.space.visibility !== "public") {
    return emitErr(socket, "not_authorized", "no access to this space", ack);
  }
  socket.data.sessionId = ctx.session.id;
  await socket.join(`session:${ctx.session.id}`);
  const capture = activeCaptures.get(ctx.session.id);
  emitState(
    io,
    ctx.session.id,
    ctx.session.state,
    capture?.recorderSocketId ?? null,
    capture?.forwardingAudio ?? false,
  );
  ack?.({ ok: true });
}

interface StartContext {
  session: SessionDbRow;
  space: SpaceCore;
  language: string | undefined;
}

async function guardStart(
  socket: ServerSocket,
  payload: unknown,
  ack: AckFn | undefined,
): Promise<StartContext | null> {
  const parsed = startSchema.safeParse(payload);
  if (!parsed.success) {
    emitErr(socket, "invalid_payload", "start payload must include session_id", ack);
    return null;
  }
  const ctx = await loadSpaceForSession(parsed.data.session_id);
  if (!ctx) {
    emitErr(socket, "not_found", "session not found", ack);
    return null;
  }
  if (ctx.session.state === "finalized") {
    emitErr(socket, "session_finalized", "session is finalized", ack);
    return null;
  }
  const role = await effectiveSpaceRole(ctx.space, socket.data.auth);
  if (!meetsRole(role, "editor")) {
    emitErr(socket, "not_authorized", "editor role required to record", ack);
    return null;
  }
  if (activeCaptures.has(ctx.session.id)) {
    emitErr(socket, "recorder_busy", "another client is recording this session", ack);
    return null;
  }
  return { session: ctx.session, space: ctx.space, language: parsed.data.language };
}

function openServiceWs(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

async function handleStart(io: IO, socket: ServerSocket, payload: unknown, ack: AckFn | undefined) {
  const ctx = await guardStart(socket, payload, ack);
  if (!ctx) return;
  let ws: WebSocket;
  try {
    ws = await openServiceWs(env.whisperStreamUrl);
  } catch (err) {
    console.error("[scribe] could not open whisper-stream WS:", err);
    return emitErr(socket, "service_unavailable", "whisper-stream is unreachable", ack);
  }
  ws.send(JSON.stringify({
    type: "start",
    ...(ctx.language ? { language: ctx.language } : {}),
    space_id: ctx.session.space_id,
  }));
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
  emitState(io, ctx.session.id, "recording", socket.id, true);
  ack?.({ ok: true, capture_id: capture.id });
}

function handleAudio(socket: ServerSocket, buf: Buffer | ArrayBuffer) {
  const sessionId = socket.data.sessionId;
  if (!sessionId) return;
  const state = activeCaptures.get(sessionId);
  if (!state || state.recorderSocketId !== socket.id) return;
  if (!state.forwardingAudio) return;
  if (state.serviceWs.readyState !== WebSocket.OPEN) return;
  state.serviceWs.send(buf);
}

async function handlePauseResume(
  io: IO,
  socket: ServerSocket,
  ack: AckFn | undefined,
  next: "recording" | "paused",
) {
  const sessionId = socket.data.sessionId;
  if (!sessionId) return ack?.({ ok: false });
  const state = activeCaptures.get(sessionId);
  if (!state || state.recorderSocketId !== socket.id) return ack?.({ ok: false });
  state.forwardingAudio = next === "recording";
  await setSessionState(sessionId, next);
  emitState(io, sessionId, next, state.recorderSocketId, state.forwardingAudio);
  ack?.({ ok: true });
}

async function handleStopOrDisconnect(io: IO, socket: ServerSocket) {
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
  emitState(io, sessionId, "stopped", null, false);
}

function bindSocketHandlers(io: IO, socket: ServerSocket) {
  socket.on("join", (payload, ack) => void handleJoin(io, socket, payload, ack));
  socket.on("start", (payload, ack) => void handleStart(io, socket, payload, ack));
  socket.on("audio", (buf) => handleAudio(socket, buf));
  socket.on("pause", (_p, ack) => void handlePauseResume(io, socket, ack, "paused"));
  socket.on("resume", (_p, ack) => void handlePauseResume(io, socket, ack, "recording"));
  socket.on("stop", (_p, ack) => {
    void handleStopOrDisconnect(io, socket);
    ack?.({ ok: true });
  });
  socket.on("disconnect", () => void handleStopOrDisconnect(io, socket));
}

export function attachSocketIO(httpServer: HttpServer): IO {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.publicOrigin || true, credentials: true },
  }) as IO;
  ioInstance = io;

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

  io.on("connection", (socket) => bindSocketHandlers(io, socket));
  return io;
}
