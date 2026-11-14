"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { speakAssistantAnswer } from "@/app/actions/assistantVoice";
import { transcribeQuestion } from "@/app/actions/voice";
import { audioForm, microphoneError, MAX_RECORDING_SECONDS } from "@/components/useVoiceRecorder";
import {
  HANDS_FREE_OFF, HIDDEN_STOPPED, IDLE_STOPPED, freshVad, handsFreeStep, mayRecord, rms, vadStep, type Phase,
} from "@/lib/handsFree";

// An empty WAV: played on the tap that starts hands-free, it unlocks the ONE audio element every answer is then
// spoken through (iPhone Safari only lets audio play that a tap started).
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const FRAME_MS = 100;

/** Play `src` through the one audio element; `done` once, when it ends, fails or is blocked. */
function playOnce(audio: HTMLAudioElement, src: string, done: (blocked: boolean) => void) {
  const off = new AbortController();
  const finish = (blocked: boolean) => {
    if (off.signal.aborted) return;
    off.abort();
    done(blocked);
  };
  audio.addEventListener("ended", () => finish(false), { signal: off.signal });
  audio.addEventListener("error", () => finish(false), { signal: off.signal });
  audio.src = src;
  void audio.play().catch(() => finish(true));
}

/**
 * The hands-free loop in the browser (rules in lib/handsFree). The audio and the words never leave except to the
 * same transcribe and ask path press-to-talk uses; nothing is logged or kept.
 */
export function useHandsFree(onQuestion: (text: string) => void) {
  const [state, dispatch] = useReducer(handsFreeStep, HANDS_FREE_OFF);
  const [note, setNote] = useState<string | null>(null);
  const phase = useRef<Phase>("off");
  useEffect(() => {
    phase.current = state.phase;
  }, [state.phase]);
  const ask = useRef(onQuestion);
  useEffect(() => {
    ask.current = onQuestion;
  }, [onQuestion]);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  // The question hands-free asked: only ITS answer is spoken, not one typed meanwhile.
  const asked = useRef<string | null>(null);

  const stop = useCallback((reason?: string) => dispatch({ type: "stop", reason }), []);

  // Started from the tap itself: the audio element and the audio context must be unlocked inside it.
  const start = useCallback(async () => {
    setNote(null);
    const audio = player.current ?? new Audio();
    player.current = audio;
    audio.src = SILENCE;
    void audio.play().catch(() => undefined);
    try {
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      void ctx.resume().catch(() => undefined);
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      // Keep the screen on while it runs (driving): a phone that sleeps hides the page, which stops it.
      wake.current = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
      dispatch({ type: "start" });
    } catch (error) {
      dispatch({ type: "stop", reason: microphoneError(error) });
    }
  }, []);

  // Off: let go of the microphone, the audio and the screen.
  useEffect(() => {
    if (state.phase !== "off") return;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    player.current?.pause();
    void wake.current?.release().catch(() => undefined);
    wake.current = null;
    asked.current = null;
  }, [state.phase]);

  // Closing the panel or leaving the page stops it.
  useEffect(() => () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    void audioCtx.current?.close().catch(() => undefined);
    player.current?.pause();
    void wake.current?.release().catch(() => undefined);
  }, []);

  // So does the tab going to the background.
  useEffect(() => {
    if (state.phase === "off") return;
    const hidden = () => {
      if (document.visibilityState === "hidden") dispatch({ type: "stop", reason: HIDDEN_STOPPED });
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [state.phase]);

  const hear = useCallback(async (audio: Blob) => {
    const heard = await transcribeQuestion(audioForm(audio)).catch(() => ({ ok: false as const, error: "Couldn't send the recording." }));
    if (phase.current !== "hearing") return; // stopped meanwhile: ask nothing
    const text = heard.ok ? heard.text.trim() : "";
    if (text) {
      setNote(null);
      asked.current = text;
      dispatch({ type: "heard" });
      ask.current(text);
    } else {
      setNote(heard.ok ? null : heard.error);
      dispatch({ type: "notHeard" });
    }
  }, []);

  // LISTENING: record, watching the level, until they've spoken and paused. The microphone is live ONLY here.
  useEffect(() => {
    const live = stream.current;
    const ctx = audioCtx.current;
    if (!mayRecord(state) || !live || !ctx) {
      live?.getAudioTracks().forEach((track) => { track.enabled = false; });
      return;
    }
    live.getAudioTracks().forEach((track) => { track.enabled = true; });
    const source = ctx.createMediaStreamSource(live);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(live);
    let send = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (send) void hear(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorder.start();
    let vad = freshVad();
    let last = performance.now();
    let total = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const now = performance.now();
      const dt = now - last;
      last = now;
      total += dt;
      const step = vadStep(vad, rms(samples), dt);
      vad = step.vad;
      if (step.verdict === "send" || (total >= MAX_RECORDING_SECONDS * 1000 && step.verdict !== "idle")) {
        clearInterval(timer);
        send = true;
        recorder.stop();
        dispatch({ type: "spoke" });
      } else if (step.verdict === "idle") {
        clearInterval(timer);
        dispatch({ type: "stop", reason: IDLE_STOPPED });
      }
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
      if (recorder.state !== "inactive") recorder.stop();
      source.disconnect();
      live.getAudioTracks().forEach((track) => { track.enabled = false; });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per time it starts listening
  }, [state.phase]);

  /** The chat calls this when an answer is in: the one to the question hands-free asked is spoken, then it listens again. */
  const answered = useCallback(async (question: string, turnId: string | undefined) => {
    if (phase.current !== "thinking" || question !== asked.current) return;
    asked.current = null;
    if (!turnId) return dispatch({ type: "answered", speak: false });
    dispatch({ type: "answered", speak: true });
    const spoken = await speakAssistantAnswer(turnId).catch(() => ({ ok: false as const, error: "Couldn't reach the server — try again.", off: false }));
    // Read again after the wait: Stop may have been pressed meanwhile.
    if ((phase.current as Phase) !== "speaking") return;
    if (!spoken.ok) {
      if (spoken.off) return dispatch({ type: "stop", reason: spoken.error });
      setNote(spoken.error);
      return dispatch({ type: "spokenEnd" });
    }
    player.current ??= new Audio();
    playOnce(player.current, spoken.audio, (blocked) => {
      if (blocked) setNote("Your browser blocked the spoken answer — it's on screen. Tap the mic again if it keeps happening.");
      dispatch({ type: "spokenEnd" });
    });
  }, []);

  return { state, note, start, stop, answered };
}
