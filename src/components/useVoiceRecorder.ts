"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Long enough for a call debrief; short enough to keep uploads small. */
export const MAX_RECORDING_SECONDS = 180;

const noSubscribe = () => () => {};

/**
 * Record from the microphone in the browser's own format (webm/opus on Chrome
 * and Android, mp4 on Safari/iPhone — the transcriber takes both). The audio
 * never leaves this hook except as the Blob handed to `onDone`, and nothing
 * stores it: callers transcribe it and drop it.
 */
export function useVoiceRecorder(onDone: (audio: Blob) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  // false on the server and in the first client render, then the real answer —
  // reading `window` during render would make server and client HTML disagree.
  const supported = useSyncExternalStore(
    noSubscribe,
    () => typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    () => false,
  );

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const audio = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (audio.size) done.current(audio);
      };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_RECORDING_SECONDS) stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      setError("Couldn't use the microphone — allow it for this site and try again.");
    }
  }, [stop]);

  // Leaving the page mid-recording must release the microphone.
  useEffect(() => stop, [stop]);

  return { supported, recording, seconds, error, start, stop };
}

/** The Blob as a FormData field for a server action. */
export function audioForm(audio: Blob, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("audio", audio, `recording.${ext}`);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}
