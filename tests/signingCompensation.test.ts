import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/signingRecoverySpy";
import { signedPdfIsUnreferenced, DURABLE_BLOB_REFERENCES } from "../src/lib/signing/compensate";
import { sweepTenantWhere, sourceSignedByThisRequest } from "../src/lib/signing/recoveryScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Quote Q-1010, production, 2026-08-04: the completion transaction COMMITTED and
 * the sealed PDF was deleted anyway, because the compensating delete treated a
 * thrown error as proof of rollback. The request read `completed`, the Document
 * row was intact with sizeBytes written from inside the transaction, and the
 * blob 404'd. It also never emailed anyone. See SIGNING-PDF-LOSS-INCIDENT.md.
 *
 * These tests hold both halves closed, and they RUN the shipped code rather than
 * reading it: the sweep sends mail, and every way it can go wrong — two workers
 * sending at once, a failed send recorded as a success, a swallowed automation,
 * another tenant's contract — is invisible to a source grep.
 */

/* ── loading the server-only modules ─────────────────────────────────────── */

/**
 * `recoverCompletions.ts` and friends are `server-only` and import a live
 * PrismaClient, mail transport and blob storage, so the unit runner cannot load
 * them as shipped. tsx compiles these tests to CommonJS, so the module loader is
 * intercepted and the real modules are then required through it — which buys
 * BEHAVIOURAL tests of the shipped functions, their real queries and their real
 * ordering, against an in-memory database.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "next/headers") return { headers: async () => ({ get: () => null }) };
  if (request === "@/lib/db") return { prisma: spy.prisma, basePrisma: spy.basePrisma };
  if (request === "@/lib/email") return { sendEmail: spy.sendEmail };
  if (request === "@/lib/storage") return { readFile: spy.readFile };
  if (request === "@/lib/errorLog") return { logError: spy.logError };
  if (request === "@/lib/audit") return { logAudit: spy.logAudit };
  if (request === "@/lib/push") return { sendPushToAll: spy.sendPushToAll };
  if (request === "@/lib/referrals") return { markReferralEarned: spy.markReferralEarned };
  if (request === "@/lib/leadJourneyEvents") {
    return { emitLeadJourneyEvent: spy.emitLeadJourneyEvent };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const requireReal = createRequire(import.meta.url);
const recovery = requireReal(
  "../src/lib/signing/recoverCompletions.ts",
) as typeof import("../src/lib/signing/recoverCompletions");
const blobRefs = requireReal(
  "../src/lib/signing/blobReferences.ts",
) as typeof import("../src/lib/signing/blobReferences");

const { recoverStrandedCompletions, MAX_RECOVERY_ATTEMPTS, RECOVERY_LEASE_MS } = recovery;

/* ── fixtures ────────────────────────────────────────────────────────────── */

const BLOB = "https://store.example/uploads/abc.pdf";
const OTHER_TENANT = "tenant_other_dealer";
/** Older than the 2-minute settlement delay, so the sweep will look at it. */
const STRANDED_AT = new Date(Date.now() - 60 * 60 * 1000);

type Seed = {
  id: string;
  tenantId?: string | null;
  quoteId?: string | null;
  jobCardId?: string | null;
  signedPdfRef?: string | null;
  signedPdfHash?: string | null;
  completedAt?: Date;
  recoveryExhaustedAt?: Date | null;
  recoveryLeaseUntil?: Date | null;
  recoveryLeaseOwner?: string | null;
};

function strandedRequest(seed: Seed): spy.Row {
  return {
    id: seed.id,
    tenantId: seed.tenantId === undefined ? null : seed.tenantId,
    title: `Contract ${seed.id}`,
    status: "completed",
    completedAt: seed.completedAt ?? STRANDED_AT,
    quoteId: seed.quoteId ?? null,
    jobCardId: seed.jobCardId ?? null,
    signedPdfRef: seed.signedPdfRef === undefined ? BLOB : seed.signedPdfRef,
    signedDocId: "doc-1",
    signedPdfHash: seed.signedPdfHash === undefined ? `hash-${seed.id}` : seed.signedPdfHash,
    deletedAt: null,
    recoveryExhaustedAt: seed.recoveryExhaustedAt ?? null,
    recoveryLeaseUntil: seed.recoveryLeaseUntil ?? null,
    recoveryLeaseOwner: seed.recoveryLeaseOwner ?? null,
  };
}

function recipient(id: string, requestId: string, email: string | null, tenantId: string | null = null): spy.Row {
  return {
    id,
    tenantId,
    requestId,
    name: `Signer ${id}`,
    email,
    role: "signer",
    order: 0,
    status: "signed",
    signedName: `Signer ${id}`,
    completedEmailSentAt: null,
  };
}

const eventsOn = (requestId: string, type: string) =>
  spy.rows("signatureEvent").filter((e) => e.requestId === requestId && e.type === type);

const sentTo = (email: string) => spy.emails.filter((e) => e.to === email);

/**
 * Move to the next cron pass.
 *
 * A FAILED attempt deliberately keeps its lease rather than releasing it, so the
 * retry is a fresh cron tick minutes later instead of a same-tick hot loop
 * against whatever is still broken. Expiring the lease here is what a real clock
 * does between passes.
 */
function nextCronTick(): void {
  for (const row of spy.rows("signatureRequest")) row.recoveryLeaseUntil = null;
}

/* ══ FINDING 1 — the claim must actually exclude a concurrent sender ═════ */

test("two overlapping sweeps send the contract ONCE, not twice", async () => {
  // The lease is the whole point. A lock taken and released around a bookkeeping
  // transaction cannot help: it is gone by the time the first email is sent, so
  // two cron passes both "claim" and both fan out. Three overlapping passes
  // would burn the entire retry budget and mail every recipient three times.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
  });

  const [a, b] = await Promise.all([
    recoverStrandedCompletions(DEFAULT_TENANT_ID),
    recoverStrandedCompletions(DEFAULT_TENANT_ID),
  ]);

  assert.equal(
    sentTo("buyer@example.com").length,
    1,
    "the signed contract was emailed twice — the claim did not hold across the external work",
  );
  assert.equal(a.recovered + b.recovered, 1, "exactly one sweep may recover a request");
  assert.equal(a.leased + b.leased, 1, "the other sweep must see the request as held, not free");
  assert.equal(eventsOn("req-1", "completed").length, 1, "one completion marker, not two");
  assert.equal(
    eventsOn("req-1", "recovery_attempt").length,
    1,
    "a sweep that never held the lease must not spend an attempt",
  );
});

test("a lease that has expired is re-claimable, so a killed worker cannot strand a request forever", async () => {
  // The other half of the lease design. Exclusivity that never lapses turns one
  // timed-out serverless invocation into a permanent silence — which is the
  // failure this whole file exists to end.
  spy.reset({
    signatureRequest: [
      strandedRequest({
        id: "req-1",
        recoveryLeaseUntil: new Date(Date.now() - 1000),
        recoveryLeaseOwner: "a-worker-that-died",
      }),
    ],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
  });

  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(result.recovered, 1, "an expired lease must not keep a recoverable request locked");
  assert.equal(sentTo("buyer@example.com").length, 1);
});

test("a live lease is long enough to cover the send", () => {
  assert.ok(
    RECOVERY_LEASE_MS >= 5 * 60 * 1000,
    "a lease shorter than the work it protects can be stolen mid-send",
  );
});

/* ══ FINDING 2 — a failed send is not a delivery ═════════════════════════ */

test("a failed send leaves the request stranded instead of marking it recovered", async () => {
  // sendEmail returns { ok: false }; it does not throw. Awaiting it and
  // discarding the result made "nobody was told" indistinguishable from
  // "everybody was told" — and the completion marker written on top of that
  // suppresses the recovery permanently, while the customer has no contract.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "bounces@example.com")],
  });
  spy.behaviour.emailFailsFor = new Set(["bounces@example.com"]);

  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(result.recovered, 0);
  assert.equal(result.failed, 1);
  assert.equal(
    eventsOn("req-1", "completed").length,
    0,
    "the completion marker must NOT be written when nobody received the document",
  );
  assert.ok(
    spy.errors.some((e) => e.scope === "signing-recovery"),
    "a failed re-drive needs a durable, operator-visible record",
  );
});

test("a retry mails only the recipient who is still missing their contract", async () => {
  // Per-RECIPIENT delivery. One unroutable address on a three-signer document
  // must cost one retry to one address, not three more copies of a signed
  // contract to people who already have it.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [
      recipient("rcp-1", "req-1", "ok@example.com"),
      recipient("rcp-2", "req-1", "bounces@example.com"),
    ],
  });
  spy.behaviour.emailFailsFor = new Set(["bounces@example.com"]);

  await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(sentTo("ok@example.com").length, 1);
  assert.equal(
    spy.rows("signatureRecipient").find((r) => r.id === "rcp-1")?.completedEmailSentAt instanceof Date,
    true,
    "a successful delivery must be recorded on the recipient",
  );

  // The address comes good; sweep again.
  spy.behaviour.emailFailsFor = new Set();
  nextCronTick();
  const second = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(second.recovered, 1);
  assert.equal(
    sentTo("ok@example.com").length,
    1,
    "the recipient who already had the contract must not be sent it again",
  );
  assert.equal(sentTo("bounces@example.com").length, 2, "the failed address is the one retried");
  assert.equal(eventsOn("req-1", "completed").length, 1);
});

/* ══ FINDING 3 — the marker must mean the fan-out really finished ════════ */

test("a swallowed audit failure withholds the completion marker", async () => {
  // runPostCompletion caught everything and returned normally, so `completed`
  // existed whether or not the audit, the referral and the journey events had
  // landed — and nothing downstream could ever see what had been swallowed.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1", quoteId: "q-1", signedPdfHash: "ours" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
    quote: [
      {
        id: "q-1",
        tenantId: null,
        number: 1010,
        signedAt: new Date(),
        signedPdfHash: "ours",
        supersededAt: null,
        deletedAt: null,
        leadId: null,
        contactId: null,
        items: [],
        fees: [],
      },
    ],
  });
  spy.behaviour.auditThrows = new Error("audit write failed");

  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(result.recovered, 0, "a fan-out with a failed effect has not finished");
  assert.equal(
    eventsOn("req-1", "completed").length,
    0,
    "the marker must not claim work that did not happen",
  );
  assert.equal(
    eventsOn("req-1", "post_completion").length,
    0,
    "the post-completion marker must not be written over a failed effect either",
  );
  // The customer is still sent their document — a broken audit table is no
  // reason to withhold a signed contract.
  assert.equal(sentTo("buyer@example.com").length, 1);
});

test("the effects that DID land are not re-fired by a retry for the ones that did not", async () => {
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1", quoteId: "q-1", signedPdfHash: "ours" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "bounces@example.com")],
    quote: [
      {
        id: "q-1",
        tenantId: null,
        number: 1010,
        signedAt: new Date(),
        signedPdfHash: "ours",
        supersededAt: null,
        deletedAt: null,
        leadId: "lead-1",
        contactId: null,
        items: [],
        fees: [],
      },
    ],
    lead: [{ id: "lead-1", tenantId: null, status: "open", deletedAt: null }],
  });
  spy.behaviour.emailFailsFor = new Set(["bounces@example.com"]);

  await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(spy.audits.length, 1, "the audit line is written once");
  assert.equal(eventsOn("req-1", "post_completion").length, 1);

  spy.behaviour.emailFailsFor = new Set();
  nextCronTick();
  await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(
    spy.audits.length,
    1,
    "a retry caused by one undelivered email must not write a second audit line for the same sale",
  );
  assert.equal(eventsOn("req-1", "completed").length, 1);
});

/* ══ FINDING 4 — the sweep is one tenant's, and so is the mail ═══════════ */

for (const mode of ["off", "enforce"] as const) {
  test(`[TENANT_ENFORCEMENT=${mode}] a sweep never touches another tenant's stranded request`, async () => {
    // The isolation must NOT depend on the mode. The db.ts guard rewrites args
    // only under enforcement, and enforcement is off in production today, so a
    // sweep relying on ambient scope is unscoped where it matters. Both runs
    // below therefore go through the same explicit predicate — with the guard
    // absent, which is the production configuration.
    const previous = process.env.TENANT_ENFORCEMENT;
    process.env.TENANT_ENFORCEMENT = mode;
    try {
      spy.reset({
        signatureRequest: [
          // The founding tenant's, un-stamped — the shape every request written
          // today actually has.
          strandedRequest({ id: "req-founding", tenantId: null }),
          strandedRequest({ id: "req-other", tenantId: OTHER_TENANT }),
        ],
        signatureRecipient: [
          recipient("rcp-founding", "req-founding", "founding@example.com", null),
          recipient("rcp-other", "req-other", "other@example.com", OTHER_TENANT),
        ],
      });

      const result = await recoverStrandedCompletions(OTHER_TENANT);

      assert.equal(result.found, 1, "the other tenant's sweep must see only its own request");
      assert.equal(sentTo("founding@example.com").length, 0, "another tenant's contract was posted");
      assert.equal(sentTo("other@example.com").length, 1);
      assert.equal(
        spy.emails[0]?.tenantId,
        OTHER_TENANT,
        "the send must run under the swept tenant's scope — that is whose SMTP identity is used",
      );
      assert.equal(eventsOn("req-founding", "completed").length, 0);
    } finally {
      if (previous === undefined) delete process.env.TENANT_ENFORCEMENT;
      else process.env.TENANT_ENFORCEMENT = previous;
    }
  });

  test(`[TENANT_ENFORCEMENT=${mode}] the founding tenant still recovers its own un-stamped requests`, async () => {
    // The failure mode of the fix. `tenantId` is not stamped on the write path
    // while enforcement is dormant, so a naive `{ tenantId: DEFAULT }` predicate
    // would match nothing at all and silently switch the whole recovery off —
    // reintroducing the bug in the name of fixing it.
    const previous = process.env.TENANT_ENFORCEMENT;
    process.env.TENANT_ENFORCEMENT = mode;
    try {
      spy.reset({
        signatureRequest: [
          strandedRequest({ id: "req-legacy", tenantId: null }),
          strandedRequest({ id: "req-stamped", tenantId: DEFAULT_TENANT_ID }),
          strandedRequest({ id: "req-other", tenantId: OTHER_TENANT }),
        ],
        signatureRecipient: [
          recipient("rcp-legacy", "req-legacy", "legacy@example.com", null),
          recipient("rcp-stamped", "req-stamped", "stamped@example.com", DEFAULT_TENANT_ID),
          recipient("rcp-other", "req-other", "other@example.com", OTHER_TENANT),
        ],
      });

      const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

      assert.equal(result.recovered, 2, "both the legacy and the stamped request are the founder's");
      assert.equal(sentTo("legacy@example.com").length, 1);
      assert.equal(sentTo("stamped@example.com").length, 1);
      assert.equal(sentTo("other@example.com").length, 0, "and the other tenant's is still not");
    } finally {
      if (previous === undefined) delete process.env.TENANT_ENFORCEMENT;
      else process.env.TENANT_ENFORCEMENT = previous;
    }
  });
}

test("a sweep without a tenant is refused, not run globally", async () => {
  await assert.rejects(
    () => recoverStrandedCompletions("" as string),
    /tenant/i,
    "an unscoped sweep would mail one tenant's contract from another's address",
  );
});

test("only the founding tenant may claim un-stamped rows", () => {
  // The rule, in isolation. NULL means "written before stamping" — and the
  // migration that backfilled these tables assigned exactly those rows to the
  // founding tenant. For anyone else a NULL row is categorically not theirs.
  assert.deepEqual(sweepTenantWhere(DEFAULT_TENANT_ID), {
    AND: [{ OR: [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: null }] }],
  });
  assert.deepEqual(sweepTenantWhere(OTHER_TENANT), { AND: [{ tenantId: OTHER_TENANT }] });
  assert.throws(() => sweepTenantWhere(""), /tenant/i);
});

/* ══ FINDING 5 — "we signed it" is not "it is signed" ════════════════════ */

test("a quote signed by another path does not get its won-effects re-fired", async () => {
  // `sourceSigned` means "THIS transaction changed the source from unsigned to
  // signed" — it came from a conditional update matching one row. Recovering on
  // "does it have a signedAt" answers a different question: a request that
  // completed after the legacy /sign path had already signed the quote gets
  // treated as the signer and re-fires quote_signed, lead-won, the referral and
  // the audit for a sale that was already booked.
  spy.reset({
    signatureRequest: [
      strandedRequest({ id: "req-1", quoteId: "q-1", signedPdfHash: "our-sealed-pdf" }),
    ],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
    quote: [
      {
        id: "q-1",
        tenantId: null,
        number: 1010,
        signedAt: new Date(),
        // Signed by SOMETHING ELSE — a different sealed PDF, so a different hash.
        signedPdfHash: "somebody-elses-sealed-pdf",
        supersededAt: null,
        deletedAt: null,
        leadId: "lead-1",
        contactId: null,
        items: [],
        fees: [],
      },
    ],
    lead: [{ id: "lead-1", tenantId: null, status: "won", deletedAt: null }],
  });

  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(result.recovered, 1, "the customer must still be sent their document");
  assert.equal(sentTo("buyer@example.com").length, 1);
  assert.deepEqual(spy.journeyEvents, [], "no won-effect may be re-fired for a sale already booked");
  assert.deepEqual(spy.referrals, [], "the referral must not be credited a second time");
  assert.equal(spy.audits.length, 0, "and no second 'quote signed' audit line");
});

test("the request that DID sign the quote still fires its won-effects", async () => {
  // The fix must not become "never fan out". The sealed PDF's hash is written
  // onto the quote by the same conditional update that means "we signed it", and
  // it is unique to this request, so it tells the two cases apart exactly.
  spy.reset({
    signatureRequest: [
      strandedRequest({ id: "req-1", quoteId: "q-1", signedPdfHash: "our-sealed-pdf" }),
    ],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
    quote: [
      {
        id: "q-1",
        tenantId: null,
        number: 1010,
        signedAt: new Date(),
        signedPdfHash: "our-sealed-pdf",
        supersededAt: null,
        deletedAt: null,
        leadId: "lead-1",
        contactId: null,
        items: [],
        fees: [],
      },
    ],
    lead: [{ id: "lead-1", tenantId: null, status: "won", deletedAt: null }],
  });

  await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(spy.audits.length, 1, "the missing audit line is written");
  assert.deepEqual(
    spy.journeyEvents.map((e) => e.type).sort(),
    ["lead_won", "quote_signed"],
    "and the automations the stranded completion never fired do fire",
  );
  assert.deepEqual(spy.referrals, ["lead-1"]);
});

test("the evidence rule refuses to guess", () => {
  assert.equal(sourceSignedByThisRequest("h", "h"), true);
  assert.equal(sourceSignedByThisRequest("h", "other"), false);
  assert.equal(sourceSignedByThisRequest(null, "h"), false, "no evidence is not a yes");
  assert.equal(sourceSignedByThisRequest("h", null), false, "an unsigned-by-us source is not a yes");
});

/* ══ FINDING 6 — every durable reference, soft-deleted rows included ═════ */

test("a soft-deleted request keeps its blob, because the Document still names it", async () => {
  // The second route to the same lost contract. `prisma.findUnique` returns null
  // for a trashed row, so a check that asks only the live SignatureRequest reads
  // "unreferenced" — and deletes the blob out from under the Document the signed
  // PDF is actually filed as, which is what the Documents tab links to.
  spy.reset({
    signatureRequest: [{ id: "req-1", tenantId: null, signedPdfRef: BLOB, deletedAt: new Date() }],
    document: [{ id: "doc-1", tenantId: null, storedName: BLOB, deletedAt: null }],
  });

  assert.equal(
    await blobRefs.signedPdfIsSafeToDelete(BLOB, null),
    false,
    "the signed contract is still filed — deleting its bytes is the incident, again",
  );
});

test("the filed Document alone is enough to keep the blob", async () => {
  // Isolates the Document probe: no request row at all, which the old check
  // treated as positive proof that nothing referenced the blob.
  spy.reset({
    signatureRequest: [],
    document: [{ id: "doc-1", tenantId: null, storedName: BLOB, deletedAt: null }],
  });

  assert.equal(await blobRefs.signedPdfIsSafeToDelete(BLOB, null), false);
});

test("a live request naming the blob keeps it — the Q-1010 regression", async () => {
  spy.reset({
    signatureRequest: [{ id: "req-1", tenantId: null, signedPdfRef: BLOB, deletedAt: null }],
    document: [],
  });
  assert.equal(await blobRefs.signedPdfIsSafeToDelete(BLOB, null), false);
});

test("a genuinely unreferenced blob is still cleaned up", async () => {
  // The fix must not become "never delete" — a real rollback should not leak.
  spy.reset({
    signatureRequest: [{ id: "req-1", tenantId: null, signedPdfRef: null, deletedAt: null }],
    document: [{ id: "doc-1", tenantId: null, storedName: "some/other.pdf", deletedAt: null }],
  });
  assert.equal(await blobRefs.signedPdfIsSafeToDelete(BLOB, null), true);
});

test("the check is scoped to the request's own tenant when it has one", async () => {
  spy.reset({
    signatureRequest: [{ id: "req-1", tenantId: OTHER_TENANT, signedPdfRef: BLOB, deletedAt: null }],
    document: [],
  });
  assert.equal(await blobRefs.signedPdfIsSafeToDelete(BLOB, OTHER_TENANT), false);
});

test("an unanswerable question is never answered with a delete", async () => {
  // NOT a corner case: the lookup usually fails for the same reason the commit
  // acknowledgement was lost — the connection is gone.
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, {
      "SignatureRequest.signedPdfRef": async () => {
        throw new Error("connection terminated");
      },
      "Document.storedName": async () => 0,
    }),
    false,
  );
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, {
      "SignatureRequest.signedPdfRef": async () => 0,
      "Document.storedName": async () => {
        throw new Error("connection terminated");
      },
    }),
    false,
    "a failure on EITHER probe keeps the file",
  );
  assert.equal(
    await signedPdfIsUnreferenced(BLOB, {
      "SignatureRequest.signedPdfRef": async () => 0,
      "Document.storedName": async () => undefined as unknown as number,
    }),
    false,
    "no answer is not a 'no'",
  );
  assert.equal(
    await signedPdfIsUnreferenced("", {
      "SignatureRequest.signedPdfRef": async () => 0,
      "Document.storedName": async () => 0,
    }),
    false,
    "a blob we cannot even name must not be deleted",
  );
});

test("a reference nobody asked about is not a reference that answered no", async () => {
  // Adding a third durable reference to the list must fail every call site
  // closed until that call site probes it, rather than silently skipping it.
  const partial = { "SignatureRequest.signedPdfRef": async () => 0 } as unknown as Parameters<
    typeof signedPdfIsUnreferenced
  >[1];
  assert.equal(await signedPdfIsUnreferenced(BLOB, partial), false);
  assert.ok(
    DURABLE_BLOB_REFERENCES.includes("Document.storedName"),
    "the filed Document is a durable reference and must be listed",
  );
});

/* ══ FINDING 7 — exhausted requests must not starve newer ones ═══════════ */

test("requests that have been given up on stop crowding out newer failures", async () => {
  // The sweep takes the OLDEST 20. A request that can never be repaired
  // automatically — Q-1010, whose PDF no longer exists to attach — stays a
  // candidate forever, so once 20 of them accumulate the batch is permanently
  // full and a new, still-recoverable failure is never even looked at.
  const doomed = Array.from({ length: 20 }, (_, i) =>
    strandedRequest({
      id: `old-${i}`,
      completedAt: new Date(STRANDED_AT.getTime() - 10_000 + i),
      signedPdfRef: null, // nothing to attach — unrecoverable, exactly like Q-1010
    }),
  );
  const doomedAttempts = doomed.flatMap((r) =>
    Array.from({ length: MAX_RECOVERY_ATTEMPTS }, (_, n) => ({
      id: `${r.id}-attempt-${n}`,
      requestId: r.id,
      type: "recovery_attempt",
      actor: "system",
    })),
  );

  spy.reset({
    signatureRequest: [...doomed, strandedRequest({ id: "fresh" })],
    signatureRecipient: [recipient("rcp-fresh", "fresh", "buyer@example.com")],
    signatureEvent: doomedAttempts,
  });

  const first = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(first.exhausted, 20, "the capped requests are recorded as needing a person");
  assert.ok(
    spy.errors.some((e) => e.scope === "signing-recovery-exhausted"),
    "giving up needs a durable operator signal, not a console line in a serverless log",
  );
  assert.equal(
    spy.rows("signatureRequest").filter((r) => r.recoveryExhaustedAt).length,
    20,
  );

  // The point: the NEXT pass can now see the newer, recoverable one.
  const second = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(second.found, 1, "the batch is no longer full of requests nobody will retry");
  assert.equal(second.recovered, 1);
  assert.equal(sentTo("buyer@example.com").length, 1);
});

test("an exhausted request is never retried again", async () => {
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1", recoveryExhaustedAt: new Date() })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
  });
  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(result.found, 0);
  assert.equal(spy.emails.length, 0);
});

test("the attempt cap is what stops a permanently broken request mailing forever", async () => {
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "bounces@example.com")],
  });
  spy.behaviour.emailFailsFor = new Set(["bounces@example.com"]);

  for (let pass = 0; pass < MAX_RECOVERY_ATTEMPTS + 3; pass += 1) {
    nextCronTick();
    await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  }

  assert.equal(
    sentTo("bounces@example.com").length,
    MAX_RECOVERY_ATTEMPTS,
    "a request that cannot be repaired must stop, not mail someone forever",
  );
  assert.equal(spy.rows("signatureRequest")[0].recoveryExhaustedAt instanceof Date, true);
});

/* ══ the honest-state guarantees that must not be regressed ══════════════ */

test("a request whose sealed PDF cannot be read is left stranded, not marked recovered", async () => {
  // Q-1010 is this case. Marking it recovered would send "your signed document
  // is attached" with nothing attached, and hide the one record that needs a
  // person to look at it.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
  });
  spy.behaviour.readFileThrows = new Error("File missing in storage");

  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);

  assert.equal(result.recovered, 0);
  assert.equal(spy.emails.length, 0, "nothing may be sent claiming an attachment that does not exist");
  assert.equal(eventsOn("req-1", "completed").length, 0);
});

test("a completion still in flight is not swept", async () => {
  // The 2-minute settlement delay. A healthy completion has committed and is
  // still fanning out; without the delay the sweep races it and double-sends.
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1", completedAt: new Date() })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
  });
  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(result.found, 0);
  assert.equal(spy.emails.length, 0);
});

test("a request that already has its completion marker is left alone", async () => {
  spy.reset({
    signatureRequest: [strandedRequest({ id: "req-1" })],
    signatureRecipient: [recipient("rcp-1", "req-1", "buyer@example.com")],
    signatureEvent: [{ id: "ev-1", requestId: "req-1", type: "completed", actor: "system" }],
  });
  const result = await recoverStrandedCompletions(DEFAULT_TENANT_ID);
  assert.equal(result.found, 0);
  assert.equal(spy.emails.length, 0);
});

/* ══ structural guards on the code paths the unit runner cannot execute ══ */

test("the completion path asks about every reference before it deletes", () => {
  const complete = shipped("src/lib/signing/complete.ts");
  const start = complete.indexOf("} catch (err) {");
  assert.notEqual(start, -1, "the completion catch block is gone — was it restructured?");
  const block = complete.slice(start, complete.indexOf("\n  }", start));

  const guard = block.indexOf("signedPdfIsSafeToDelete(");
  const del = block.indexOf("deleteFile(");
  assert.notEqual(guard, -1, "the catch must consult the database before deleting");
  assert.notEqual(del, -1, "the delete is gone — a genuine rollback would now leak its blob");
  // The property that matters: nothing can reach the delete without passing
  // through the check first. An unguarded delete IS the bug.
  assert.ok(del > guard, "the delete must come after the check, not before it");
  assert.match(
    block.slice(guard, del),
    /\)\)\s*\{\s*$/m,
    "the delete must sit inside the check's block, not merely after it",
  );

  // And the check must run on the UNFILTERED client, or a trashed request hides
  // the reference it is supposed to find.
  const refs = shipped("src/lib/signing/blobReferences.ts");
  assert.match(refs, /basePrisma\.signatureRequest\.count/, "soft-deleted rows must still be seen");
  assert.match(refs, /basePrisma\.document\.count/, "the filed Document is the other durable reference");
});

test("the completion event is written LAST and only on success", () => {
  // The detector is "status completed, but no completed event". That only means
  // "the fan-out never finished" if the event is written after the fan-out AND
  // withheld when the fan-out failed.
  const complete = shipped("src/lib/signing/complete.ts");
  const fanout = complete.indexOf("runPostCompletion(");
  const email = complete.indexOf("deliverCompletionEmails(");
  const event = complete.indexOf("type: COMPLETED_EVENT");
  assert.notEqual(event, -1, "the completed event is gone");
  assert.ok(event > fanout, "the completed event must be written AFTER runPostCompletion");
  assert.ok(event > email, "the completed event must be written AFTER the recipient emails");
  assert.match(
    complete.slice(email, event),
    /if \(post\.ok && delivery\.ok\)/,
    "the marker must be conditional on BOTH the effects and the delivery succeeding",
  );
});

test("the live completion path emails through the same guarded fan-out as the recovery", () => {
  // Both loops had the same bug — `await sendEmail(...)` with the result thrown
  // away — so both must go through the one implementation that checks it.
  const complete = shipped("src/lib/signing/complete.ts");
  assert.doesNotMatch(
    complete,
    /await sendEmail\(/,
    "an unchecked sendEmail is the bug; use deliverCompletionEmails",
  );
  const recover = shipped("src/lib/signing/recoverCompletions.ts");
  assert.doesNotMatch(recover, /await sendEmail\(/);
  assert.match(shipped("src/lib/signing/completionFanout.ts"), /if \(!result\.ok\)/);
});

test("the sweep detects exactly the stranded shape, and settles first", () => {
  const recover = shipped("src/lib/signing/recoverCompletions.ts");
  assert.match(recover, /status:\s*"completed"/, "it must look at completed requests");
  assert.match(
    recover,
    /events:\s*\{\s*none:\s*\{\s*type:\s*COMPLETED_EVENT\s*\}\s*\}/,
    "the detector is the ABSENCE of the completion event",
  );
  assert.match(
    recover,
    /completedAt:\s*\{\s*lt:\s*cutoff\s*\}/,
    "a completion still in flight must not be swept, or the sweep double-sends a healthy request's email",
  );
});

test("the sweep runs on the cron, for one named tenant", () => {
  const route = shipped("src/app/api/cron/automations/route.ts");
  assert.match(
    route,
    /phase\(\s*"stranded-completions",\s*\(\) => recoverStrandedCompletions\(tenantId \?\? DEFAULT_TENANT_ID\)/,
    "a recovery nothing calls recovers nothing — and one with no tenant mails the wrong people",
  );
});
