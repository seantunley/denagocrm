"use client";

import { useState, useTransition } from "react";
import { Loader2, Play } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { saveSetting } from "@/app/actions/settings";
import { previewVoice } from "@/app/actions/voicePreview";

type Voice = { id: string; name: string; accent: string | null; category: string | null };

/**
 * The voice DAX and the chatbot speak with: picked from the voices in the workspace's ElevenLabs account (or typed,
 * when the list can't be read), and HEARD before it is saved — ▶ plays a sample with the workspace's model, speed and
 * pronunciations (Sean, 2026-11-02: choose a South African voice by ear).
 */
export default function VoicePicker({ voices, current }: { voices: Voice[] | null; current: string }) {
  const [voiceId, setVoiceId] = useState(current);
  const [audio, setAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const known = voices?.some((v) => v.id === current) ?? false;

  const play = (language: "en" | "af") =>
    start(async () => {
      setError(null);
      const result = await previewVoice(voiceId, language);
      if (result.ok) setAudio(result.audio);
      else setError(result.error);
    });

  return (
    <div className="space-y-2">
      <SaveForm resetOnSuccess={false} action={saveSetting} className="flex flex-wrap gap-2 items-end">
        <input type="hidden" name="key" value="ELEVENLABS_VOICE_ID" />
        <div className="flex-1 min-w-56">
          <label className="label">Voice</label>
          {voices && voices.length > 0 ? (
            <select name="value" className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {!known && current ? <option value={current}>Saved voice ({current})</option> : null}
              {!current ? <option value="">Choose a voice…</option> : null}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.accent ? ` — ${v.accent}` : ""}
                  {v.category && v.category !== "premade" ? ` (${v.category})` : ""}
                </option>
              ))}
            </select>
          ) : (
            <input name="value" className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="Voice ID from elevenlabs.io" />
          )}
        </div>
        <button type="button" onClick={() => play("en")} disabled={pending || !voiceId} className="btn-secondary inline-flex items-center gap-1">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Play a sample
        </button>
        <button type="button" onClick={() => play("af")} disabled={pending || !voiceId} className="btn-secondary btn-sm">
          Afrikaans
        </button>
        <SaveButton className="btn-primary">Save</SaveButton>
      </SaveForm>
      {audio ? <audio src={audio} controls autoPlay className="w-full max-w-md" /> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        Voices in your ElevenLabs account. For a South African voice, add one from the ElevenLabs Voice Library (search
        &ldquo;South African&rdquo;) or design or clone one there — it then shows up here. The sample is played with the model,
        speed and pronunciations below as they are saved.
      </p>
    </div>
  );
}
