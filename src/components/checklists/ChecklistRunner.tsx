"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, ChevronLeft, Images, Loader2, TriangleAlert, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  CHECKLIST_LIMITS,
  MIN_SKIP_REASON,
  isPhotoCapture,
  outstanding,
  type CaptureKind,
  type ChecklistRunInput,
  type EntryState,
  type EntryStatus,
  type Outstanding,
} from "@/lib/checklists/types";
import {
  countPending,
  drain,
  enqueue,
  remove as removeQueued,
  type QueuedPhoto,
} from "@/lib/checklists/queue";
import { preparePhoto, unsendablePhoto, uploadPhoto } from "@/lib/photoTransport";
import {
  completeChecklistRun,
  registerChecklistPhoto,
  syncChecklistRun,
} from "@/app/actions/checklistRuns";

/**
 * Capturing a checklist, one step per screen.
 *
 * ── WHO IS HOLDING THE PHONE ────────────────────────────────────────────────
 *
 * Somebody standing beside a vehicle in the rain, one hand on the phone and the
 * other on a door. Every decision here follows from that. One step per screen,
 * never a scrolling form — a twelve-item form on a phone is a form where steps
 * four to nine are never actually looked at, and the photos come back wrong. The
 * step's own `description` sits directly above the camera, because "the plate on
 * the frame under the seat, not the box" is only useful at the moment the camera
 * is about to be pointed somewhere. The primary action is full width at the
 * bottom, in the thumb's arc.
 *
 * ── THE ORDER OF OPERATIONS IS NOT NEGOTIABLE ───────────────────────────────
 *
 *     create locally → syncChecklistRun → drain the photo queue → complete
 *
 * A photo's upload token is authorised against its ENTRY: /api/photos/upload
 * looks the entry up, resolves the run behind it, and demands the permission
 * that run's host demands. So the entry has to exist server-side before a single
 * byte can go up. Draining first does not merely fail — it burns a retry on
 * every photo in the queue and lands them all in the stuck list for a reason
 * that has nothing to do with the photos.
 *
 * The run and its entries are created on the DEVICE, with client-minted ids, so
 * none of that blocks the capture itself. See the note on ChecklistRun.id in
 * prisma/checklists.prisma: a driveway on one bar of signal is the least
 * reliable moment of the job and the worst possible time to need a round trip.
 *
 * ── COMPLETENESS IS DECIDED IN ONE PLACE ────────────────────────────────────
 *
 * `outstanding()` from lib/checklists/types.ts, the same function the server
 * uses. This screen runs it before it asks, so the usual case never costs a
 * refusal; and when the server refuses anyway — which means photos it expected
 * did not arrive — the same list is what gets drawn. Two implementations of
 * "finished" is how a screen comes to insist a run is complete while the server
 * keeps saying it is not, with nothing on screen to say which step is at fault.
 */

/* ── what the screen is handed ────────────────────────────────────────── */

export type RunnerItem = {
  id: string;
  label: string;
  description: string | null;
  capture: CaptureKind;
  required: boolean;
  minPhotos: number;
  maxPhotos: number;
  sortOrder: number;
};

export type RunnerTemplate = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  items: RunnerItem[];
};

/**
 * An entry that is already on the server, for a run being picked up again.
 *
 * Carries the SNAPSHOTS rather than the template's current items, because a run
 * answers the list as it stood when it started — re-reading today's template
 * would let an edit made this morning silently change what somebody is halfway
 * through recording.
 */
export type RunnerEntry = {
  id: string;
  itemId: string | null;
  labelSnapshot: string;
  descriptionSnapshot: string | null;
  captureSnapshot: CaptureKind;
  requiredSnapshot: boolean;
  minPhotosSnapshot: number;
  /** Not snapshotted on the entry — a ceiling for this screen, not a rule. */
  maxPhotos: number;
  sortOrder: number;
  status: EntryStatus;
  note: string | null;
  value: string | null;
  skipReason: string | null;
  /** Photos that have already reached the server for this entry. */
  photoCount: number;
};

export type RunnerRun = {
  id: string;
  /** ISO-8601, because a Date does not survive the server→client boundary. */
  startedAt: string;
  entries: RunnerEntry[];
};

/** A photo taken on this device, not yet counted by the server. */
type Capture = {
  id: string;
  /** An object URL, so the person can see what they actually photographed. */
  preview: string;
  /**
   * False when IndexedDB was unavailable and the photo went straight up. Such a
   * photo is NOT in the queue, so it must not be counted as waiting.
   */
  queued: boolean;
};

type Session = { runId: string; startedAt: string; entries: RunnerEntry[] };

export default function ChecklistRunner({
  tenantId,
  hostType,
  hostId,
  template,
  run,
  triggerLabel,
  triggerClassName,
}: {
  /** Needed to build the blob path the upload route will authorise. */
  tenantId: string;
  hostType: string;
  hostId: string;
  template: RunnerTemplate;
  /** Present when an unfinished run is being picked up rather than started. */
  run?: RunnerRun;
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [step, setStep] = useState(0);
  const [captures, setCaptures] = useState<Record<string, Capture[]>>({});
  const [queued, setQueued] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Outstanding[]>([]);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState("");

  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  /*
   * Every object URL this component ever minted.
   *
   * A revoked URL is a blank thumbnail, so they are only released when the whole
   * screen goes away. Held in a ref rather than in state because the cleanup
   * must not be a reason to re-render, and an effect that depended on the list
   * would revoke the URLs it had just been given.
   */
  const previews = useRef<Set<string>>(new Set());
  /*
   * Photos this browser could not queue AND could not send yet.
   *
   * Both halves have to be true to land here: no IndexedDB (or a full one), and
   * a run that does not exist server-side yet, so the upload route has no entry
   * to authorise against. Held in memory and flushed the moment the sync lands.
   *
   * Without this they were simply lost — counted locally, so this screen thought
   * the step was answered, and absent on the server, so `completeChecklistRun`
   * refused with a reason the person could do nothing about. A ref rather than
   * state because carrying a File is not something to re-render over.
   */
  const carried = useRef<{ id: string; entryId: string; file: File; capturedAt: string }[]>([]);
  useEffect(() => {
    const held = previews.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const entries = session?.entries ?? [];
  const current = entries[step];

  /** The completeness input: server-side photos plus the ones still on the phone. */
  const states: EntryState[] = entries.map((entry) => ({
    id: entry.id,
    labelSnapshot: entry.labelSnapshot,
    captureSnapshot: entry.captureSnapshot,
    requiredSnapshot: entry.requiredSnapshot,
    minPhotosSnapshot: entry.minPhotosSnapshot,
    status: entry.status,
    note: entry.note,
    value: entry.value,
    skipReason: entry.skipReason,
    photoCount: entry.photoCount + (captures[entry.id]?.length ?? 0),
  }));

  const refreshQueued = useCallback(async (runId: string) => {
    setQueued(await countPending(runId));
  }, []);

  function buildSession(): Session {
    if (run) return { runId: run.id, startedAt: run.startedAt, entries: run.entries.map((e) => ({ ...e })) };
    /*
     * Ids minted here, in an event handler, and never during a render.
     *
     * `crypto.randomUUID()` in a render body would produce a different id on the
     * server than on the client and make the whole subtree a hydration mismatch;
     * it would also mint a fresh run every time React re-rendered the screen.
     */
    const startedAt = new Date().toISOString();
    return {
      runId: crypto.randomUUID(),
      startedAt,
      entries: [...template.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item, index) => ({
          id: crypto.randomUUID(),
          itemId: item.id,
          labelSnapshot: item.label,
          descriptionSnapshot: item.description,
          captureSnapshot: item.capture,
          requiredSnapshot: item.required,
          minPhotosSnapshot: item.minPhotos,
          maxPhotos: Math.max(1, item.maxPhotos),
          sortOrder: index,
          status: "pending" as EntryStatus,
          note: null,
          value: null,
          skipReason: null,
          photoCount: 0,
        })),
    };
  }

  /**
   * The first step that still needs something.
   *
   * Reopening at step one on a twelve-step list means scrolling past everything
   * already done to find the gap, which is exactly what somebody who put the
   * phone down halfway through does not want to do.
   */
  function resumeStep(list: RunnerEntry[]): number {
    const done = new Set(
      outstanding(
        list.map((entry) => ({
          id: entry.id,
          labelSnapshot: entry.labelSnapshot,
          captureSnapshot: entry.captureSnapshot,
          requiredSnapshot: entry.requiredSnapshot,
          minPhotosSnapshot: entry.minPhotosSnapshot,
          status: entry.status,
          note: entry.note,
          value: entry.value,
          skipReason: entry.skipReason,
          photoCount: entry.photoCount + (captures[entry.id]?.length ?? 0),
        })),
      ).map((item) => item.id),
    );
    const first = list.findIndex((entry) => done.has(entry.id) || entry.status === "pending");
    return first === -1 ? Math.max(0, list.length - 1) : first;
  }

  function onOpenChange(next: boolean) {
    if (next) {
      // Kept across a close, so shutting the screen to answer a phone call does
      // not throw away captures that have not been synced yet.
      const built = session ?? buildSession();
      setSession(built);
      setStep(resumeStep(built.entries));
      setProblem(null);
      setNotice(null);
      setBlockers([]);
      setSkipping(false);
      setSkipReason("");
      void refreshQueued(built.runId);
    }
    setOpen(next);
  }

  function patch(entryId: string, change: Partial<RunnerEntry>) {
    setSession((previous) =>
      previous
        ? { ...previous, entries: previous.entries.map((e) => (e.id === entryId ? { ...e, ...change } : e)) }
        : previous,
    );
  }

  /* ── taking a photo ───────────────────────────────────────────────── */

  async function acceptFiles(entry: RunnerEntry, chosen: File[]) {
    if (!session || chosen.length === 0) return;
    const already = entry.photoCount + (captures[entry.id]?.length ?? 0);
    const room = Math.min(entry.maxPhotos, CHECKLIST_LIMITS.photosPerItem) - already;
    if (room <= 0) {
      setProblem(`“${entry.labelSnapshot}” already has all the photos it takes.`);
      return;
    }

    setProblem(null);
    setBusy("Saving the photo…");
    const added: Capture[] = [];
    let refused: string | null = null;
    let sentDirectly = 0;

    for (const original of chosen.slice(0, room)) {
      /*
       * SHRUNK BEFORE IT IS STORED, not on the way out.
       *
       * A walk-around is twenty photos; twenty 4 MB originals is most of a
       * phone's IndexedDB quota, and the browser answering QuotaExceededError
       * halfway through is the queue itself becoming the thing that loses
       * evidence. Same downscale the direct uploader uses — one implementation,
       * in lib/photoTransport.ts.
       */
      const file = await preparePhoto(original);
      const reason = unsendablePhoto(file);
      if (reason) {
        refused = reason;
        continue;
      }

      const id = crypto.randomUUID();
      const result = await enqueue({ id, runId: session.runId, entryId: entry.id, blob: file });
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);

      if (result.stored) {
        added.push({ id, preview, queued: true });
        continue;
      }
      /*
       * No offline store, or a full one. Degrade to sending it now rather than
       * losing it — but only if the run already exists server-side, because the
       * upload token is authorised against the entry. If it does not, the sync
       * on Finish is what will carry it, so the bytes are held in memory on this
       * screen and the person is told the honest thing: do not close the app.
       */
      try {
        await sendNow(entry.id, id, file, result.item.capturedAt);
        added.push({ id, preview, queued: false });
        sentDirectly++;
      } catch {
        added.push({ id, preview, queued: false });
        carried.current.push({ id, entryId: entry.id, file, capturedAt: result.item.capturedAt });
        refused =
          "This browser will not keep photos offline. This one is being held in memory and sent when you save — keep this screen open until then.";
      }
    }

    setCaptures((previous) => ({ ...previous, [entry.id]: [...(previous[entry.id] ?? []), ...added] }));
    if (added.length > 0) patch(entry.id, { status: "done", skipReason: null });
    await refreshQueued(session.runId);
    setBusy(null);
    setProblem(refused);
    setNotice(sentDirectly > 0 ? `${sentDirectly} photo${sentDirectly === 1 ? "" : "s"} sent immediately.` : null);
  }

  async function sendNow(entryId: string, photoId: string, file: File, capturedAt: string) {
    const url = await uploadPhoto({ kind: "checklist", recordId: entryId, tenantId, key: photoId }, file);
    const result = await registerChecklistPhoto(entryId, [{ url, id: photoId, capturedAt }]);
    if (result.error) throw new Error(result.error);
  }

  /** Send whatever is being carried in memory. Returns how many are still stuck. */
  async function flushCarried(): Promise<number> {
    if (carried.current.length === 0) return 0;
    const stuck: typeof carried.current = [];
    for (const item of carried.current) {
      try {
        await sendNow(item.entryId, item.id, item.file, item.capturedAt);
      } catch {
        // Kept, not dropped. The id is stable, so a later attempt that succeeds
        // after an earlier one half-succeeded still converges on one row.
        stuck.push(item);
      }
    }
    carried.current = stuck;
    return stuck.length;
  }

  async function dropCapture(entryId: string, photoId: string) {
    await removeQueued(photoId);
    setCaptures((previous) => ({
      ...previous,
      [entryId]: (previous[entryId] ?? []).filter((capture) => capture.id !== photoId),
    }));
    if (session) await refreshQueued(session.runId);
  }

  /**
   * Send one queued photo. Handed to `drain`, which owns the retry accounting.
   *
   * A throw is the signal to keep the blob and count an attempt, so every
   * failure — transfer or filing — must throw rather than be swallowed. A photo
   * whose bytes landed but whose row did not will be re-sent, and that is fine:
   * the photo's id is client-minted and is the row's primary key, so the second
   * arrival converges on the same row rather than creating a duplicate.
   */
  const uploader = useCallback(
    async (item: QueuedPhoto) => {
      const file = new File([item.blob], `${item.id}.jpg`, { type: item.blob.type || "image/jpeg" });
      const url = await uploadPhoto(
        { kind: "checklist", recordId: item.entryId, tenantId, key: item.id },
        file,
      );
      const result = await registerChecklistPhoto(item.entryId, [
        { url, id: item.id, capturedAt: item.capturedAt },
      ]);
      if (result.error) throw new Error(result.error);
    },
    [tenantId],
  );

  /* ── saving ───────────────────────────────────────────────────────── */

  function payload(active: Session): ChecklistRunInput {
    return {
      id: active.runId,
      templateId: template.id,
      hostType: hostType as ChecklistRunInput["hostType"],
      hostId,
      startedAt: new Date(active.startedAt),
      entries: active.entries.map((entry) => ({
        id: entry.id,
        itemId: entry.itemId,
        labelSnapshot: entry.labelSnapshot,
        descriptionSnapshot: entry.descriptionSnapshot ?? undefined,
        captureSnapshot: entry.captureSnapshot,
        requiredSnapshot: entry.requiredSnapshot,
        minPhotosSnapshot: entry.minPhotosSnapshot,
        sortOrder: entry.sortOrder,
        status: entry.status,
        note: entry.note ?? undefined,
        value: entry.value ?? undefined,
        skipReason: entry.skipReason ?? undefined,
        recordedAt: entry.status === "pending" ? undefined : new Date(),
      })),
    };
  }

  /**
   * Push the run up, then push its photos up. In that order, always.
   *
   * Returns the problem to show, or null. One call site for each of the two
   * server calls, so the ordering cannot drift into a second copy that has them
   * the wrong way round.
   */
  async function syncAndUpload(active: Session): Promise<string | null> {
    setBusy("Saving the checklist…");
    const synced = await syncChecklistRun(payload(active));
    if (synced.error) return synced.error;

    setBusy("Uploading photos…");
    // The memory-held ones first: they have no store to retry them from, so this
    // is the only chance they get, and it exists only now that the sync has put
    // their entries on the server for the upload token to be authorised against.
    const stranded = await flushCarried();
    const report = await drain(active.runId, uploader);
    await refreshQueued(active.runId);

    if (stranded > 0) {
      return `${stranded} photo${stranded === 1 ? "" : "s"} could not be sent and this browser cannot hold them offline. Do not close this screen — try again when the signal is better.`;
    }

    if (report.stuck.length > 0) {
      const first = report.stuck[0];
      return `${report.stuck.length} photo${report.stuck.length === 1 ? " has" : "s have"} failed too many times and will not be retried: ${first.lastError ?? "no reason recorded"}`;
    }
    if (report.failed > 0) {
      return `${report.failed} photo${report.failed === 1 ? "" : "s"} could not be uploaded. They are still on this device — try again when the signal is better.`;
    }
    return null;
  }

  async function saveProgress() {
    if (!session) return;
    setProblem(null);
    setNotice(null);
    const failure = await syncAndUpload(session);
    setBusy(null);
    setProblem(failure);
    if (!failure) {
      setNotice("Saved. You can close this and carry on later.");
      router.refresh();
    }
  }

  async function finish() {
    if (!session) return;
    setProblem(null);
    setNotice(null);

    // Asked here first, so the ordinary case never costs a refused round trip
    // and the person sees the gap immediately rather than after two uploads.
    const local = outstanding(states);
    if (local.length > 0) {
      setBlockers(local);
      setProblem("Some steps still need something before this can be finished.");
      return;
    }
    setBlockers([]);

    const failure = await syncAndUpload(session);
    if (failure) {
      setBusy(null);
      setProblem(failure);
      return;
    }

    setBusy("Finishing…");
    const done = await completeChecklistRun(session.runId);
    setBusy(null);
    if (done.error) {
      /*
       * The server refused after this screen thought it was complete, which in
       * practice means photos it expected are not there. Its own answer is
       * shown, and the local list beside it, because "the run is incomplete"
       * with no pointer sends somebody through all twelve steps looking.
       */
      setProblem(done.error);
      setBlockers(outstanding(states));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  /* ── skipping ─────────────────────────────────────────────────────── */

  function confirmSkip(entry: RunnerEntry) {
    const reason = skipReason.trim();
    /*
     * Refused HERE, not on the server.
     *
     * A required step that can be skipped with an empty box is not required, and
     * finding that out after a round trip — at the end, on a bad connection —
     * means the person has walked away from the vehicle. Same threshold the
     * server enforces (MIN_SKIP_REASON), so the two cannot disagree.
     */
    if (entry.requiredSnapshot && reason.length < MIN_SKIP_REASON) {
      setProblem(
        `“${entry.labelSnapshot}” is a required step. Say why it is being skipped — at least ${MIN_SKIP_REASON} characters.`,
      );
      return;
    }
    setProblem(null);
    patch(entry.id, { status: "skipped", skipReason: reason || null });
    setSkipping(false);
    setSkipReason("");
    goNext();
  }

  function goNext() {
    setBlockers([]);
    setSkipping(false);
    setSkipReason("");
    setStep((value) => Math.min(value + 1, Math.max(0, entries.length - 1)));
  }

  function goBack() {
    setBlockers([]);
    setSkipping(false);
    setSkipReason("");
    setStep((value) => Math.max(0, value - 1));
  }

  /* ── drawing ──────────────────────────────────────────────────────── */

  const total = entries.length;
  const onLastStep = total > 0 && step === total - 1;
  const label = triggerLabel ?? (run ? "Carry on" : "Start");

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={cn("btn-primary btn-sm", triggerClassName)}
      >
        <Camera className="size-3.5" aria-hidden="true" />
        {label}
      </button>

      <Sheet open={open} onOpenChange={onOpenChange}>
        {/* Bottom sheet, nearly full height: the capture screen IS the screen
            while it is open, and a side panel on a phone is a column three words
            wide. `dvh` rather than `vh` so the browser's own chrome sliding away
            does not leave the footer under the address bar. */}
        <SheetContent side="bottom" className="h-[94dvh] gap-0 p-0">
          <SheetHeader className="border-b border-border p-4 pb-3">
            <SheetTitle className="pr-8 text-base">{template.name}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span aria-live="polite">
                {total === 0 ? "No steps configured" : `Step ${step + 1} of ${total}`}
              </span>
              {queued > 0 && (
                // Said out loud, always. A person who has taken eight photos on
                // no signal has no other way to know whether they have arrived,
                // and "it looked like it saved" is how evidence goes missing.
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {queued} photo{queued === 1 ? "" : "s"} waiting to upload
                </span>
              )}
            </SheetDescription>
            <div
              className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={step + 1}
              aria-label="Checklist progress"
            >
              {/* Inline width: a percentage cannot be a Tailwind class, because
                  Tailwind scans source TEXT and a computed `w-[${n}%]` is never
                  generated into the stylesheet. */}
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${total === 0 ? 0 : ((step + 1) / total) * 100}%` }}
              />
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!current ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                This list has no steps yet. Add some in Settings → Checklists.
              </p>
            ) : (
              <Step
                entry={current}
                captures={captures[current.id] ?? []}
                skipping={skipping}
                skipReason={skipReason}
                cameraRef={cameraRef}
                galleryRef={galleryRef}
                onFiles={(files) => void acceptFiles(current, files)}
                onDropCapture={(photoId) => void dropCapture(current.id, photoId)}
                onPatch={(change) => patch(current.id, change)}
                onSkipReason={setSkipReason}
                onStartSkip={() => setSkipping(true)}
                onCancelSkip={() => {
                  setSkipping(false);
                  setSkipReason("");
                }}
                onConfirmSkip={() => confirmSkip(current)}
              />
            )}

            {blockers.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  Still outstanding
                </p>
                {/* Every one of these jumps to the step it is about. A list of
                    complaints you cannot act on is worse than no list. */}
                <ul className="mt-2 space-y-1">
                  {blockers.map((item) => (
                    <li key={`${item.id}-${item.reason}`}>
                      <button
                        type="button"
                        onClick={() => {
                          const index = entries.findIndex((entry) => entry.id === item.id);
                          if (index >= 0) setStep(index);
                          setBlockers([]);
                        }}
                        className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-amber-100 hover:bg-amber-500/10"
                      >
                        <span className="font-medium">{item.label}</span> — {item.reason}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {problem && (
              <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200" role="alert">
                {problem}
              </p>
            )}
            {notice && !problem && (
              <p className="mt-4 text-xs text-muted-foreground" aria-live="polite">
                {notice}
              </p>
            )}
          </div>

          {/* One-handed: the primary action is the full width of the sheet at
              the very bottom, where a thumb already is. Back and Skip are
              secondary and deliberately smaller. */}
          <div className="border-t border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={goBack}
                disabled={step === 0 || busy !== null}
                className="btn-secondary min-h-11 flex-1"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                Back
              </button>
              <button
                type="button"
                onClick={() => void saveProgress()}
                disabled={busy !== null || !session}
                className="btn-secondary min-h-11 flex-1"
              >
                Save for later
              </button>
            </div>
            <button
              type="button"
              onClick={() => (onLastStep ? void finish() : goNext())}
              disabled={busy !== null || total === 0}
              className="btn-primary min-h-14 w-full text-base"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {busy}
                </>
              ) : onLastStep ? (
                <>
                  <Check className="size-4" aria-hidden="true" />
                  Finish
                </>
              ) : (
                "Next step"
              )}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/* ── one step ─────────────────────────────────────────────────────────── */

function Step({
  entry,
  captures,
  skipping,
  skipReason,
  cameraRef,
  galleryRef,
  onFiles,
  onDropCapture,
  onPatch,
  onSkipReason,
  onStartSkip,
  onCancelSkip,
  onConfirmSkip,
}: {
  entry: RunnerEntry;
  captures: Capture[];
  skipping: boolean;
  skipReason: string;
  cameraRef: React.RefObject<HTMLInputElement | null>;
  galleryRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
  onDropCapture: (photoId: string) => void;
  onPatch: (change: Partial<RunnerEntry>) => void;
  onSkipReason: (value: string) => void;
  onStartSkip: () => void;
  onCancelSkip: () => void;
  onConfirmSkip: () => void;
}) {
  const photos = isPhotoCapture(entry.captureSnapshot);
  const held = entry.photoCount + captures.length;
  const multiple = entry.maxPhotos > 1;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold leading-tight text-foreground">
          {entry.labelSnapshot}
          {!entry.requiredSnapshot && (
            <span className="ml-2 align-middle text-[11px] font-normal text-muted-foreground">optional</span>
          )}
        </h3>
        {/* The guidance sits above the camera, which is the only place it is
            read. Below the button it is a caption nobody sees until afterwards. */}
        {entry.descriptionSnapshot && (
          <p className="mt-1 text-sm leading-snug text-muted-foreground">{entry.descriptionSnapshot}</p>
        )}
      </div>

      {photos && (
        <div className="space-y-2">
          {/*
            TWO WAYS IN, and both are needed.

            `capture="environment"` opens the rear camera directly, which is the
            whole point on a phone — one tap from the step to the lens. But the
            photo was sometimes taken five minutes ago, before the person walked
            back inside to a signal, and an input carrying `capture` gives some
            browsers no way to reach the gallery at all. So there is a second
            input without it.

            Both are hidden and driven by real buttons: a hidden input is not
            focusable, so the button is the one thing in the tab order, and it
            can carry a proper label and a focus ring.
          */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple={multiple}
            className="hidden"
            aria-label={`Take a photo for ${entry.labelSnapshot}`}
            onChange={(event) => {
              onFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <input
            ref={galleryRef}
            type="file"
            accept="image/*"
            multiple={multiple}
            className="hidden"
            aria-label={`Choose a saved photo for ${entry.labelSnapshot}`}
            onChange={(event) => {
              onFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />

          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5 text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Camera className="size-10" aria-hidden="true" />
            <span className="text-base font-semibold">Take a photo</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {held} of {entry.minPhotosSnapshot > 0 ? entry.minPhotosSnapshot : 1} needed
              {entry.maxPhotos > entry.minPhotosSnapshot ? ` · up to ${entry.maxPhotos}` : ""}
            </span>
          </button>

          <button
            type="button"
            onClick={() => galleryRef.current?.click()}
            className="btn-secondary min-h-11 w-full"
          >
            <Images className="size-4" aria-hidden="true" />
            Choose a photo already taken
          </button>

          {captures.length > 0 && (
            <ul className="flex flex-wrap gap-2 pt-1">
              {captures.map((capture) => (
                <li key={capture.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an
                      object URL for a blob that only exists on this device; the
                      image optimiser has nothing to fetch. */}
                  <img
                    src={capture.preview}
                    alt={`Photo captured for ${entry.labelSnapshot}`}
                    className="size-16 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => onDropCapture(capture.id)}
                    aria-label={`Remove this photo from ${entry.labelSnapshot}`}
                    className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-destructive"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {entry.captureSnapshot === "photo_note" && (
        <div>
          <label className="label" htmlFor={`note-${entry.id}`}>
            Note
          </label>
          <textarea
            id={`note-${entry.id}`}
            className="input min-h-20"
            maxLength={CHECKLIST_LIMITS.noteLength}
            value={entry.note ?? ""}
            onChange={(event) => onPatch({ note: event.target.value, status: "done" })}
          />
        </div>
      )}

      {entry.captureSnapshot === "boolean" && (
        <fieldset className="space-y-2">
          <legend className="label">Answer</legend>
          <div className="flex gap-2">
            {(["true", "false"] as const).map((answer) => (
              <button
                key={answer}
                type="button"
                aria-pressed={entry.value === answer}
                onClick={() => onPatch({ value: answer, status: "done" })}
                className={cn(
                  "min-h-14 flex-1 rounded-xl border text-base font-semibold transition-colors",
                  entry.value === answer
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40",
                )}
              >
                {answer === "true" ? "Yes" : "No"}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {(entry.captureSnapshot === "text" || entry.captureSnapshot === "number") && (
        <div>
          <label className="label" htmlFor={`value-${entry.id}`}>
            {entry.labelSnapshot}
          </label>
          <input
            id={`value-${entry.id}`}
            className="input min-h-12 text-base"
            type={entry.captureSnapshot === "number" ? "number" : "text"}
            inputMode={entry.captureSnapshot === "number" ? "decimal" : "text"}
            maxLength={CHECKLIST_LIMITS.valueLength}
            value={entry.value ?? ""}
            onChange={(event) =>
              onPatch({ value: event.target.value, status: event.target.value.trim() ? "done" : "pending" })
            }
          />
        </div>
      )}

      {skipping ? (
        <div className="rounded-xl border border-border bg-muted/20 p-3">
          <label className="label" htmlFor={`skip-${entry.id}`}>
            {entry.requiredSnapshot
              ? `Why is this being skipped? (at least ${MIN_SKIP_REASON} characters)`
              : "Why is this being skipped? (optional)"}
          </label>
          <textarea
            id={`skip-${entry.id}`}
            className="input min-h-20"
            maxLength={CHECKLIST_LIMITS.skipReasonLength}
            value={skipReason}
            onChange={(event) => onSkipReason(event.target.value)}
            placeholder="e.g. no charger was in the box"
          />
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={onCancelSkip} className="btn-secondary min-h-11 flex-1">
              Cancel
            </button>
            <button type="button" onClick={onConfirmSkip} className="btn-danger min-h-11 flex-1">
              Skip this step
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={onStartSkip} className="btn-secondary min-h-11 w-full">
          Skip this step
        </button>
      )}

      {entry.status === "skipped" && entry.skipReason && (
        <p className="text-xs text-muted-foreground">Skipped — {entry.skipReason}</p>
      )}
    </div>
  );
}
