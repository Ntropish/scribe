import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export type RecorderState =
  | "idle"
  | "requesting_mic"
  | "recording"
  | "paused"
  | "stopping"
  | "error";

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

export function useRecorder({
  sessionId,
  onLine,
  onLineUpdated,
  onPartial,
  onState,
}: UseRecorderOptions): RecorderApi {
  const [state, setState] = useState<RecorderState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recorderSocketId, setRecorderSocketId] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  // The recorder hook owns its socket so the connection's lifetime matches
  // the session view. Other listeners on the same page can opt into the
  // same socket via the returned helpers if needed.
  useEffect(() => {
    const socket = io({
      withCredentials: true,
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join", { session_id: sessionId });
    });
    socket.on("line", (evt: LineEvent) => onLine(evt));
    socket.on("line_updated", (evt: LineEvent) => onLineUpdated(evt));
    socket.on("partial", (evt: PartialEvent) => onPartial(evt));
    socket.on("state", (evt: StateEvent) => {
      setRecorderSocketId(evt.recorder_socket_id);
      onState(evt);
    });
    socket.on("error", (evt: { code: string; message: string }) => {
      setErrorMessage(`${evt.code}: ${evt.message}`);
      if (evt.code === "recorder_busy") {
        setState("error");
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sessionId, onLine, onLineUpdated, onPartial, onState]);

  // beforeunload safety: release the lock if the recorder tab closes.
  useEffect(() => {
    function handle() {
      const socket = socketRef.current;
      if (socket && socket.connected) {
        socket.emit("stop");
      }
    }
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, []);

  const start = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    setErrorMessage(null);
    setState("requesting_mic");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      await audioCtx.audioWorklet.addModule("/scribe-audio-worklet.js");
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "scribe-audio-worklet");
      workletRef.current = worklet;

      worklet.port.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        if (socket.connected) socket.emit("audio", ev.data);
      };

      source.connect(worklet);

      await new Promise<void>((resolve, reject) => {
        socket.emit("start", { session_id: sessionId }, (resp: { ok: boolean; error?: string }) => {
          if (resp?.ok) resolve();
          else reject(new Error(resp?.error || "start failed"));
        });
      });

      setState("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      setState("error");
      teardownLocal();
    }
  }, [sessionId]);

  const pause = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit("pause");
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.emit("resume");
    setState("recording");
  }, []);

  function teardownLocal() {
    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }

  const stop = useCallback(async () => {
    const socket = socketRef.current;
    setState("stopping");
    if (socket) {
      socket.emit("stop");
    }
    teardownLocal();
    setState("idle");
  }, []);

  const iAmRecorder =
    !!socketRef.current?.id && recorderSocketId === socketRef.current.id;

  return {
    state,
    errorMessage,
    recorderSocketId,
    iAmRecorder,
    start,
    pause,
    resume,
    stop,
  };
}
