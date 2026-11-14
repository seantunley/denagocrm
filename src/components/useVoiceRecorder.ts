"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { micStarter } from "@/lib/micStarter";

/** Long enough for a call debrief; short enough to keep uploads small. */
export const MAX_RECORDING_SECONDS = 180;
/** A recorded phone call (Log a call → Record the call). At 32 kbps that is ≈ 3.6 MB. */
export const CALL_RECORDING_SECONDS = 15 * 60;

/** `maxSeconds` / `bitsPerSecond` are read when a recording STARTS, so a caller may change them between recordings. */
export type RecorderOptions = { maxSeconds?: number; bitsPerSecond?: number };

const noSubscribe = () => () => {};

/**
 * Record from the microphone in the browser's own format (webm/opus on Chrome
 * and Android, mp4 on Safari/iPhone — the transcriber takes both). The audio
 * never leaves this hook except as the Blob handed to `onDone`, and nothing
 * stores it: callers transcribe it and drop it.
 */
export function useVoiceRecorder(onDone: (audio: Blob) => void, options: RecorderOptions = {}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const done = useRef(onDone);
  const opts = useRef(options);
  useEffect(() => {
    done.current = onDone;
    opts.current = options;
  });

  // false on the server and in the first client render, then the real answer —
  // reading `window` during render would make server and client HTML disagree.
  const supported = useSyncExternalStore(
    noSubscribe,
    () => typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    () => false,
  );

  // The permission prompt, cancellable (lib/micStarter, shared with hands-free): Stop, Cancel and unmount void a
  // request still waiting.
  // No wake lock: a recording is short and the person is looking at the page.
  const [mic] = useState(() => micStarter<MediaStream>({ getMic: () => navigator.mediaDevices.getUserMedia({ audio: true }) }));
  const [waiting, setWaiting] = useState(false);
  // Set on unmount: a recording cut short by leaving the page is dropped, never sent.
  const gone = useRef(false);

  /** Stop recording — or, while the permission prompt is still open, stop it from ever starting. Also Cancel. */
  const stop = useCallback(() => {
    mic.cancel();
    setWaiting(false);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, [mic]);

  const start = useCallback(async () => {
    // No overlapping starts: already recording, or a request already waiting (never a second prompt).
    if (recorder.current?.state === "recording" || mic.waiting()) return;
    setError(null);
    try {
      setWaiting(true);
      const stream = (await mic.start())?.stream ?? null;
      setWaiting(false);
      // Cancelled (or unmounted) while the prompt was open: its microphone is already off. Nothing starts.
      if (!stream || gone.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      const chunks: Blob[] = [];
      const { maxSeconds = MAX_RECORDING_SECONDS, bitsPerSecond } = opts.current;
      const rec = new MediaRecorder(stream, bitsPerSecond ? { audioBitsPerSecond: bitsPerSecond } : undefined);
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (audio.size && !gone.current) done.current(audio);
      };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= maxSeconds) stop();
          return s + 1;
        });
      }, 1000);
    } catch (error) {
      setWaiting(false);
      setError(microphoneError(error));
    }
  }, [mic, stop]);

  // Leaving the page must release the microphone — a recording under way, or a permission prompt still open — and
  // send nothing.
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      stop();
    };
  }, [stop]);

  return { supported, recording, waiting, seconds, error, start, stop };
}

/** The Blob as a FormData field for a server action. */
export function audioForm(audio: Blob, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("audio", audio, `recording.${ext}`);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

/**
 * Why the microphone couldn't be used, in words that say what to do. Every
 * failure used to read "allow it for this site" — including the ones where it
 * WAS allowed (no microphone plugged in, another app holding it), which sent
 * people round in circles.
 */
export function microphoneError(error: unknown): string {
  const name = error instanceof Error || (error && typeof error === "object" && "name" in error) ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The microphone is blocked — allow it for this site in your browser (the icon left of the address bar), then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found — plug one in or pick one in your computer's sound settings.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy — close any other app using it (a call, a recorder) and try again.";
  return "Couldn't use the microphone — check it's connected and allowed for this site, then try again.";
}
