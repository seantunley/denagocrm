import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, logCallDetail, parseActionList } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE, cardEmoji } from "../src/lib/assistantWhatsAppRules";
import { familyOf } from "../src/lib/assistantOutcomeRules";
import { DEBRIEF_INSTRUCTIONS, parseDebrief } from "../src/lib/voiceDebrief";

/**
 * Sean, 2026-11-14: "Calls. Record or dictate a call, and DAX writes the summary, files it and proposes the
 * follow-up." The Log a call button (record / talk it through / type) and DAX's log_call card share one save.
 */
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LEAD = "clead00000000001";

test("log_call: a call that happened, on a deal or a customer, with its follow-up", () => {
  const [call] = parseActionList([{ type: "log_call", leadId: LEAD, summary: "Wants the XL in white", notes: "• Finance via the bank", nextStep: "Send the finance form", followUp: "2026-11-20" }]);
  assert.deepEqual(call, { type: "log_call", leadId: LEAD, activity: "call", summary: "Wants the XL in white", notes: "• Finance via the bank", nextStep: "Send the finance form", followUp: "2026-11-20" });
  assert.equal(parseActionList([{ type: "log_call", contactId: LEAD, summary: "Visit", activity: "meeting" }]).length, 1, "on a customer, as a visit");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD }]).length, 0, "a summary is required");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD, summary: "x", followUp: "Friday" }]).length, 0, "a follow-up is a date");
  assert.equal(parseActionList([{ type: "log_call", leadId: LEAD, summary: "x", recording: "…" }]).length, 0, "strict");
});

test("the card says everything Confirm files — and that nobody is contacted", () => {
  const detail = logCallDetail({ activity: "call", notes: "• Wants white", nextStep: "Send the form", followUpLabel: "Fri 20 Nov, 09:00" });
  assert.match(detail, /• Wants white\nNext step: Send the form\nFollow-up call booked: Fri 20 Nov, 09:00\n/);
  assert.match(detail, /completed call — the customer is not contacted/);
  assert.match(logCallDetail({ activity: "meeting", notes: "" }), /\(no notes\)\nNo follow-up booked\.\nFiled as a completed visit/);
});

test("DAX is told when to log a call — and never to double-book its follow-up", () => {
  assert.match(ACTION_INSTRUCTIONS, /- log_call: a call or visit that ALREADY HAPPENED/);
  assert.match(ACTION_INSTRUCTIONS, /never a separate follow_up for the same call/);
  assert.match(ACTION_INSTRUCTIONS, /A call still to make is a follow_up, not a log_call/);
  assert.match(ACTION_INSTRUCTIONS, /when the customer has more than one open deal, ask which/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("log_call"), "confirmable from the car, on WhatsApp");
  assert.equal(cardEmoji("log_call"), "📞");
  assert.equal(familyOf("log_call").key, "notes");
});

test("Confirm saves through the Log a call button's own action — checked again, never on the card's word", () => {
  const run = code("src/app/actions/assistant.ts");
  const body = run.slice(run.indexOf('case "log_call": {'), run.indexOf('case "note": {'));
  assert.match(body, /await logVoiceDebrief\(\{/);
  const build = code("src/lib/crmAssistant.ts");
  const card = build.slice(build.indexOf('if (p.type === "log_call") {'), build.indexOf('if (p.type === "follow_up" || p.type === "meeting") {'));
  assert.match(card, /hasPermission\(user, "activities\.manage"\)/);
  assert.match(card, /canAccessLead\(user, p\.leadId\)/);
  assert.match(card, /canAccessContact\(user, p\.contactId!\)/);
  assert.match(card, /deletedAt: null/);
});

test("a recorded call: the consent line first, up to 15 minutes, transcribed and dropped", () => {
  const button = code("src/components/VoiceDebriefButton.tsx");
  assert.match(button, /Tell the customer the call is being recorded before you start/);
  // The microphone opens only from the button under that line.
  const record = button.slice(button.indexOf('if (mode === "record") {'));
  assert.ok(record.indexOf("Tell the customer") < record.indexOf("onClick={voice.start}"));
  assert.match(button, /mode === "record" \? \{ maxSeconds: CALL_RECORDING_SECONDS, bitsPerSecond: 32_000 \}/);
  assert.match(code("src/components/useVoiceRecorder.ts"), /export const CALL_RECORDING_SECONDS = 15 \* 60;/);
  const voice = code("src/app/actions/voice.ts");
  assert.match(voice, /const MAX_CALL_AUDIO_BYTES = 15 \* 1024 \* 1024;/);
  assert.match(voice, /call \? \{ timeoutMs: 180_000 \} : \{\}/, "a long call gets time to transcribe");
  assert.match(code("next.config.ts"), /bodySizeLimit: "16mb"/, "a 15 MB call fits the server action's limit");
});

test("Log a call is on the customer page as well as the deal, for those who may log activities", () => {
  const customer = code("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(customer, /\{canBookTestDrive && <VoiceDebriefButton contactId=\{contact\.id\} openDeals=\{openDeals\} \/>\}/);
  assert.match(customer, /canBookTestDrive, canOpenJobCard\] = await Promise\.all\(\[[\s\S]*?hasPermission\(user, "activities\.manage"\),\s*hasPermission\(user, "jobcards\.manage"\)/);
  assert.match(code("src/app/(app)/leads/[id]/page.tsx"), /<VoiceDebriefButton leadId=\{lead\.id\} \/>/);
});

// ── Review of #1117 ─────────────────────────────────────────────────────────────────────────────────────────────

/** A permission prompt held open: resolve() grants, reject() refuses. */
function deferredMic() {
  const tracks = [{ live: true, stop() { this.live = false; } }];
  let grant!: () => void;
  let refuse!: (e: Error) => void;
  const calls = { n: 0 };
  const getMic = () => {
    calls.n++;
    return new Promise<{ getTracks(): typeof tracks }>((resolve, reject) => {
      grant = () => resolve({ getTracks: () => tracks });
      refuse = reject;
    });
  };
  return { tracks, getMic, calls, grant: () => grant(), refuse: (e: Error) => refuse(e) };
}

// The recorder asks through the SAME cancellable helper as hands-free (lib/micStarter), with no wake lock.
test("Cancel while the permission prompt is open: granted afterwards, the microphone goes straight off and nothing starts", async () => {
  const { micStarter } = await import("../src/lib/micStarter");
  const prompt = deferredMic();
  const mic = micStarter({ getMic: prompt.getMic });
  const started = mic.start();
  assert.equal(mic.waiting(), true, "waiting for permission");
  mic.cancel(); // Cancel, Stop or unmount — the hook calls the same cancel for each
  assert.equal(mic.waiting(), false);
  prompt.grant();
  assert.equal(await started, null, "nothing to record with");
  assert.equal(prompt.tracks[0].live, false, "no live microphone track");
});

test("a refusal after Cancel is nobody's error; a fresh start after Cancel gets the microphone, with no wake lock asked", async () => {
  const { micStarter } = await import("../src/lib/micStarter");
  const refused = deferredMic();
  const mic = micStarter({ getMic: refused.getMic });
  const first = mic.start();
  mic.cancel();
  refused.refuse(new Error("NotAllowedError"));
  assert.equal(await first, null);
  assert.equal(mic.waiting(), false);

  const granted = deferredMic();
  const again = micStarter({ getMic: granted.getMic });
  const live = again.start();
  granted.grant();
  const got = await live;
  assert.ok(got && granted.tracks[0].live && got.wake === null, "not cancelled: the microphone is handed over, no wake lock");
  assert.equal(again.waiting(), false, "answered: no longer waiting");
});

test("the shared recorder (every caller: Log a call, the DAX chat mic) cancels a waiting prompt on Stop, Cancel and unmount", () => {
  const hook = code("src/components/useVoiceRecorder.ts");
  assert.match(hook, /const \[mic\] = useState\(\(\) => micStarter<MediaStream>\(\{ getMic: \(\) => navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\) \}\)\);/);
  // Never a second prompt: the hook asks only when no start is waiting (the helper itself would replace it).
  assert.ok(hook.indexOf("mic.waiting()) return;") < hook.indexOf("await mic.start()"));
  assert.ok(!code("src/lib/handsFree.ts").includes("export function micStarter"), "one helper, not two");
  assert.doesNotMatch(hook, /await navigator\.mediaDevices\.getUserMedia/, "never a request that can't be cancelled");
  const stop = hook.slice(hook.indexOf("const stop = useCallback("), hook.indexOf("const start = useCallback("));
  assert.match(stop, /mic\.cancel\(\);/);
  const start = hook.slice(hook.indexOf("const start = useCallback("), hook.indexOf("// Leaving the page must release"));
  assert.match(start, /if \(recorder\.current\?\.state === "recording" \|\| mic\.waiting\(\)\) return;/, "no overlapping starts");
  assert.ok(start.indexOf("if (!stream || gone.current)") < start.indexOf("new MediaRecorder("), "cancelled or unmounted: no recorder");
  assert.match(hook, /return \(\) => \{\s*gone\.current = true;\s*stop\(\);\s*\};/, "unmount: cancel, and send nothing");
  assert.match(hook, /if \(audio\.size && !gone\.current\) done\.current\(audio\);/);
  const button = code("src/components/VoiceDebriefButton.tsx");
  assert.match(button, /Waiting for microphone permission…/);
  assert.match(button, /const cancel = \(\) => \{ voice\.stop\(\); setMode\(null\); setError\(null\); \};/);
  // The DAX chat mic (micPress, since hands-free #1113): pressed again while the prompt is open, it cancels.
  assert.match(code("src/components/AssistantChat.tsx"), /return voice\.recording \|\| voice\.waiting \? voice\.stop\(\) : void voice\.start\(\);/);
});

test("saving a call is all or nothing, once: checked first, one transaction, its key spent with it", () => {
  const actions = code("src/app/actions/activities.ts");
  const body = actions.slice(actions.indexOf("export async function logVoiceDebrief"), actions.indexOf("export async function cancelActivity"));
  const firstWrite = body.indexOf("await prisma.$transaction(async (tx) => {");
  assert.ok(firstWrite > 0, "one interactive transaction");
  assert.doesNotMatch(body, /prisma\.\$transaction\(\[/, "never the array form (it throws on the scoped client)");
  assert.ok(body.indexOf("followUpDueDateError(followUpAt)") < firstWrite, "the follow-up's time is checked before anything is written");
  assert.ok(body.indexOf("assistantPendingAction.findFirst({ where: { id: data.opKey") < firstWrite, "a repeat returns before writing");
  const tx = body.slice(firstWrite, body.indexOf("}).catch("));
  assert.ok(tx.indexOf("findStaffAvailabilityConflict(") < tx.indexOf("tx.activity.create"), "a clash returns before the first write");
  for (const write of ["tx.activity.create", "tx.communication.create", "tx.assistantPendingAction.create"]) assert.ok(tx.includes(write), write);
  assert.doesNotMatch(tx, /prisma\.(activity|communication)\./, "every write on the transaction");
  assert.doesNotMatch(body, /scheduleFollowUpBody\(/, "the follow-up is booked inside the transaction, not after it");
  assert.match(body, /code === "P2002"\) return \{ repeated: true \}/, "two Saves at once: the second is the first's repeat");
  // Both callers send one key per draft / card.
  assert.match(code("src/components/VoiceDebriefButton.tsx"), /opKey: `qk_\$\{crypto\.randomUUID\(\)\.replace\(\/-\/g, ""\)\}`/);
  const run = code("src/app/actions/assistant.ts");
  assert.match(run.slice(run.indexOf('case "log_call": {')), /opKey: card\.confirmKey,/);
});

test("log_call with no activity is a call — normalised where the card is made (review of #1117)", () => {
  const build = code("src/lib/crmAssistant.ts");
  const card = build.slice(build.indexOf('if (p.type === "log_call") {'), build.indexOf('if (p.type === "follow_up" || p.type === "meeting") {'));
  assert.match(card, /const activity = p\.activity === "meeting" \? "meeting" : "call";/);
  assert.doesNotMatch(card, /p\.activity(?! === "meeting")/, "nothing else reads the raw value");
  assert.match(card, /confirmKey: `qk_\$\{randomBytes\(16\)\.toString\("hex"\)\}`/);
});

test("a transcript of the call itself is written up like a debrief", () => {
  assert.match(DEBRIEF_INSTRUCTIONS, /a transcript of the call itself/);
  const draft = parseDebrief('{"summary":"Marcel: XL in white","notes":["Wants finance"],"nextStep":"Call back","followUpDays":3}', "Hi Marcel…", "2026-11-14");
  assert.equal(draft?.followUpDate, "2026-11-17");
});
