import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export type RecorderState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "recording"
  | "paused"
  | "stopping"
  | "error";

const START_ACK_TIMEOUT_MS = 15000;

export interface LineEvent {
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

export interface PartialEvent {
  text: string;
  capture_id: string;
}

export interface StateEvent {
  session_id: string;
  state: "recording" | "paused" | "stopped" | "finalized";
  is_audio_flowing: boolean;
  recorder_socket_id: string | null;
}

export interface RecorderApi {
  state: RecorderState;
  errorMessage: string | null;
  recorderSocketId: string | null;
  iAmRecorder: boolean;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
}

interface UseRecorderOptions {
  sessionId: string;
  onLine: (line: LineEvent) => void;
  onLineUpdated: (line: LineEvent) => void;
  onPartial: (partial: PartialEvent) => void;
  onState: (state: StateEvent) => void;
}

interface AudioPipeline {
  audioCtx: AudioContext;
  worklet: AudioWorkletNode;
  stream: MediaStream;
}

async function acquireMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

async function buildAudioPipeline(
  stream: MediaStream,
  onChunk: (buf: ArrayBuffer) => void,
): Promise<AudioPipeline> {
  const audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule("/scribe-audio-worklet.js");
  const source = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, "scribe-audio-worklet");
  worklet.port.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) onChunk(ev.data);
  };
  source.connect(worklet);
  return { audioCtx, worklet, stream };
}

function teardownPipeline(pipeline: AudioPipeline | null) {
  if (!pipeline) return;
  pipeline.worklet.disconnect();
  void pipeline.audioCtx.close();
  for (const track of pipeline.stream.getTracks()) track.stop();
}

interface CallbackHandle {
  onLine: (line: LineEvent) => void;
  onLineUpdated: (line: LineEvent) => void;
  onPartial: (partial: PartialEvent) => void;
  onState: (state: StateEvent) => void;
}

function wireSocket(
  socket: Socket,
  sessionId: string,
  cbRef: { current: CallbackHandle },
  setError: (m: string) => void,
) {
  socket.on("connect", () => socket.emit("join", { session_id: sessionId }));
  socket.on("line", (evt: LineEvent) => cbRef.current.onLine(evt));
  socket.on("line_updated", (evt: LineEvent) => cbRef.current.onLineUpdated(evt));
  socket.on("partial", (evt: PartialEvent) => cbRef.current.onPartial(evt));
  socket.on("state", (evt: StateEvent) => cbRef.current.onState(evt));
  socket.on("error", (evt: { code: string; message: string }) => {
    setError(`${evt.code}: ${evt.message}`);
  });
}

function emitStartAck(socket: Socket, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`server didn't acknowledge start within ${START_ACK_TIMEOUT_MS}ms`));
    }, START_ACK_TIMEOUT_MS);
    socket.emit("start", { session_id: sessionId }, (resp: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (resp?.ok) resolve();
      else reject(new Error(resp?.error || "start failed"));
    });
  });
}

export function useRecorder(opts: UseRecorderOptions): RecorderApi {
  const { sessionId } = opts;
  const [state, setState] = useState<RecorderState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recorderSocketId, setRecorderSocketId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const pipelineRef = useRef<AudioPipeline | null>(null);
  // Keep the latest callbacks in a ref so the socket listeners always invoke
  // the current versions without forcing the effect to re-run (which would
  // tear down and recreate the socket on every render).
  const callbacksRef = useRef<CallbackHandle>({
    onLine: opts.onLine,
    onLineUpdated: opts.onLineUpdated,
    onPartial: opts.onPartial,
    onState: opts.onState,
  });
  callbacksRef.current = {
    onLine: opts.onLine,
    onLineUpdated: opts.onLineUpdated,
    onPartial: opts.onPartial,
    onState: opts.onState,
  };

  useEffect(() => {
    // Polling first (works through CF without configuration), upgrade to
    // WebSocket once connected. Confirmed the 101 upgrade response comes
    // back cleanly through the tunnel; the earlier WS failures were a
    // casualty of the socket-churn bug, not a transport issue.
    const socket = io({
      withCredentials: true,
      autoConnect: true,
      transports: ["polling", "websocket"],
    });
    socketRef.current = socket;
    wireSocket(socket, sessionId, callbacksRef, (msg) => {
      setErrorMessage(msg);
      if (msg.startsWith("recorder_busy:")) setState("error");
    });
    socket.on("state", (evt: StateEvent) => {
      setRecorderSocketId(evt.recorder_socket_id);
      // The server is authoritative about whether this session is being
      // recorded. If it transitions to a non-recording state while we still
      // believe we're the active recorder, the upstream capture died on us
      // (e.g. whisper-stream disconnected). Release the mic and surface an
      // error so the controls can't keep claiming we're recording.
      if (evt.state === "stopped" || evt.state === "finalized") {
        setState((prev) => {
          if (prev !== "recording" && prev !== "paused") return prev;
          teardownPipeline(pipelineRef.current);
          pipelineRef.current = null;
          setErrorMessage(
            evt.state === "finalized"
              ? "session was finalized"
              : "recording ended: transcription service disconnected",
          );
          return "error";
        });
      }
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    function handle() {
      const socket = socketRef.current;
      if (socket?.connected) socket.emit("stop");
    }
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, []);

  const start = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    setErrorMessage(null);
    setState("requesting_mic");
    let stream: MediaStream | null = null;
    try {
      stream = await acquireMicStream();
      setState("connecting");
      await emitStartAck(socket, sessionId);
      // Build the worklet only after the server has acked. Otherwise
      // audio chunks start streaming before the start handler runs,
      // saturating the (polling) transport and starving the ack.
      pipelineRef.current = await buildAudioPipeline(stream, (buf) => {
        if (socket.connected) socket.emit("audio", buf);
      });
      setState("recording");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setState("error");
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      teardownPipeline(pipelineRef.current);
      pipelineRef.current = null;
    }
  }, [sessionId]);

  const pause = useCallback(() => {
    socketRef.current?.emit("pause");
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    socketRef.current?.emit("resume");
    setState("recording");
  }, []);

  const stop = useCallback(async () => {
    setState("stopping");
    socketRef.current?.emit("stop");
    teardownPipeline(pipelineRef.current);
    pipelineRef.current = null;
    setState("idle");
  }, []);

  const iAmRecorder =
    !!socketRef.current?.id && recorderSocketId === socketRef.current.id;

  return { state, errorMessage, recorderSocketId, iAmRecorder, start, pause, resume, stop };
}
