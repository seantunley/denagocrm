import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { microphoneError } from "../src/components/useVoiceRecorder";

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the site lets its own pages use the microphone — and nobody else's", () => {
  // `microphone=()` forbade it on every page whatever the browser allowed, so
  // voice questions to DAX and voice debriefs failed everywhere (2026-10-07).
  const policy = /key: "Permissions-Policy",\s*value: "([^"]+)"/.exec(code("next.config.ts"))?.[1] ?? "";
  assert.match(policy, /(^|, )microphone=\(self\)(,|$)/);
  assert.doesNotMatch(policy, /microphone=\(\)|microphone=\*/);
  assert.match(policy, /camera=\(self\)/);
  assert.match(policy, /geolocation=\(\)/);
});

test("a microphone failure says what actually went wrong", () => {
  const err = (name: string) => Object.assign(new Error("x"), { name });
  assert.match(microphoneError(err("NotAllowedError")), /blocked — allow it/);
  assert.match(microphoneError(err("NotFoundError")), /No microphone found/);
  assert.match(microphoneError(err("NotReadableError")), /busy/);
  assert.match(microphoneError({ name: "SecurityError" }), /blocked/);
  assert.match(microphoneError("weird"), /check it's connected/);
});
