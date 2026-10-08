import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { notHeard } from "../src/lib/voiceNotHeard";

/*
 * 2026-10-07: every recording failed because the workspace's ElevenLabs key
 * lacked the Speech to Text permission (ElevenLabs answered 401
 * missing_permissions), and the person was told to check their microphone.
 * The REAL ElevenLabs call, against a stubbed fetch, now says it was the key.
 */

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  const file = (parent?.filename ?? "").replace(/\\/g, "/");
  if (file.endsWith("src/lib/elevenlabs.ts")) {
    if (request === "./settings") return { getSetting: async (key: string) => (key === "ELEVENLABS_API_KEY" ? "xi_test" : null) };
    if (request === "./errorLog") return { logError: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { elevenLabsSTTChecked, elevenLabsSTTDetailed } = createRequire(import.meta.url)("../src/lib/elevenlabs.ts") as typeof import("../src/lib/elevenlabs");

const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
};
const audio = Buffer.from("not really audio");

test("a key without Speech to Text is reported as that, not as silence", async () => {
  answer(401, { detail: { type: "authentication_error", code: "unauthorized", status: "missing_permissions", message: "The API key you used is missing the permission speech_to_text to execute this operation." } });
  assert.deepEqual(await elevenLabsSTTChecked(audio, "audio/webm"), { refused: "permission" });
  assert.equal(await elevenLabsSTTDetailed(audio, "audio/webm"), null, "the WhatsApp callers still just see no transcript");

  answer(401, { detail: { status: "invalid_api_key" } });
  assert.deepEqual(await elevenLabsSTTChecked(audio, "audio/webm"), { refused: "key" });

  answer(200, { text: "  What needs my attention today?  ", language_code: "eng", language_probability: 0.98 });
  assert.equal(((await elevenLabsSTTChecked(audio, "audio/webm")) as { text: string }).text, "What needs my attention today?");

  answer(200, { text: "" });
  assert.equal(await elevenLabsSTTChecked(audio, "audio/webm"), null, "a silent recording is still just nothing heard");
});

test("each cause gets the message that points at its fix", () => {
  assert.match(notHeard({ refused: "permission" }, true), /isn't allowed to transcribe — in ElevenLabs, edit the API key and tick Speech to Text/);
  assert.match(notHeard({ refused: "key" }, true), /didn't accept the key/);
  assert.match(notHeard(null, true), /check the right microphone/);
  assert.match(notHeard(null, false), /Voice isn't set up/);
});

test("the recorder's server action uses the checked transcriber and the shared wording", () => {
  const voice = readFileSync(new URL("../src/app/actions/voice.ts", import.meta.url), "utf8");
  assert.match(voice, /const heard = await transcribeVoiceChecked\(Buffer\.from\(await audio\.arrayBuffer\(\)\), audio\.type\);/);
  assert.match(voice, /return \{ ok: false, error: notHeard\(heard, await isElevenLabsConfigured\(\)\) \};/);
});
