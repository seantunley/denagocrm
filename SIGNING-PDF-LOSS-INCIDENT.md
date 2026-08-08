# Signed PDF lost on Quote Q-1010 — 2026-08-04

Diagnosed 2026-08-05 from read-only production queries. Every fact below is
evidenced; the one inference is labelled as such.

## What a person saw

Opening the signed quote returned `{"error":"File missing in storage"}`.

## What the database says

| Fact | Value |
|---|---|
| `SignatureRequest.status` | `completed` |
| `SignatureRequest.completedAt` | `2026-08-04T16:37:47.149Z` |
| `SignatureRequest.signedPdfRef` | `…/uploads/d504bca1-…pdf` |
| `SignatureRequest.signedPdfHash` | `d36f49a15790512bbf4ab929b2bd2d247def7da19d3a88764f1fd6cd4d2f9d70` |
| `Document` row | **exists, `deletedAt` null**, `sizeBytes` 106111 |
| `Quote.signedAt` / `.status` | `2026-08-04T16:37:47.168Z` / `accepted` |
| The blob itself | **HTTP 404** |
| Both signature PNGs | **HTTP 200** — still present |

`Document.sizeBytes` is written from `pdf.length` *inside* the transaction, so
the upload succeeded and the row committed. This rules out the competing
explanation — that the signed `Document` was soft-deleted and purged by the
60-day trash sweep (`src/lib/trash.ts`). That row is intact.

## The audit trail, and the thing it is missing

Twelve `SignatureEvent` rows, ending:

```
2026-08-04T16:37:41.827Z  signed  | actor: Gavin Tagg | ch: web
```

and then nothing. **There is no `completed` event.**

That is decisive. `logSignEvent(requestId, { type: "completed" })` is the first
statement *after* the `try/catch` in `completeSignatureRequest`. The row was
committed at `16:37:47.149Z`, and the event that immediately follows a successful
commit was never written. So the code committed the transaction and then took the
failure path.

## Root cause

`completeSignatureRequest` uploads the sealed PDF *before* the transaction — it
has to, because the blob's name is written into the row — and compensated
unconditionally on failure:

```ts
} catch (err) {
  await deleteFile(storedName).catch(() => {});
  if (err instanceof CompletionLost || err instanceof SourceCompletionLost) return;
  throw err;
}
```

**The unsound assumption is that a thrown error means the transaction rolled
back.** It does not. When the `COMMIT` succeeds and only its acknowledgement is
lost, Postgres has committed: `signedPdfRef` and the new `Document` row both name
that blob — and this line then deletes the file underneath them.

*Inference (not proven):* the acknowledgement was most likely lost to the Neon
pooled connection — a reset, a compute suspend, or a pooler timeout. What is
proven is that the process was still alive (the delete ran) and the data
committed. A Prisma interactive-transaction timeout is ruled out, because that
path issues a `ROLLBACK` and the data would not be there.

The window is not narrow. The transaction makes seven round trips, including two
`SELECT … FOR UPDATE`, over a pooled connection from a serverless function.

## The loss is not recoverable in kind

Re-rendering produces a different `signedPdfHash`, so a replacement is provably
not the artefact anybody signed. Vercel Blob has no undelete.

The *inputs* all survive — `snapshotJson` (the frozen document as the signers saw
it), both signature PNGs, the field definitions and responses, signed names,
timestamps, IPs, and the full event trail — so a faithful reproduction can be
rebuilt. It will not be byte-identical.

## The second failure, which is worse

Because the error was not one of the two sentinels, the `catch` **rethrew**.
Everything after it never ran:

- `logSignEvent(… "completed")` — hence the missing event
- `runPostCompletion(…)` — referral, automations, push, audit
- **the loop that emails the sealed PDF to every recipient**

So neither signer ever received their signed document by email.

**Nothing can re-drive it.** `advanceAfterSignature` returns early on
`isRequestClosed(req.status)`, and `completeSignatureRequest` does the same. The
status is now `completed`, so both refuse. The request is permanently stranded:
the database says completed, while the notification, the automations and the
audit never happened and never will.

This is silent. There is no failed-job row, no alert, and the CRM UI shows the
quote as signed and accepted.

## Will it happen again?

**Without a fix, yes.** Nothing about the cause is specific to this quote, and it
occurred on the only completed signing in the database — so the window is not
rare enough to discount.

Two fixes are needed, and they are independent.

### 1. Stop deleting a blob that may be referenced — *in this PR*

`src/lib/signing/compensate.ts` moves the decision out of the `catch` and inverts
its default: delete **only** on a positive answer that nothing references the
blob. Every ambiguous outcome keeps the file — including the case where the
verifying read itself fails, which is usually the same broken connection that
lost the acknowledgement in the first place.

An orphaned blob costs a few hundred kilobytes. A deleted one costs a contract.

### 2. Re-drive stranded completions — *NOT in this PR, still open*

The fan-out needs to be recoverable. A request whose row says `completed` but
which has no `completed` `SignatureEvent` is, by construction, one that committed
and never fanned out — a precise and cheap query. A sweep should find those and
re-run the notification and post-completion steps idempotently.

Until that exists, fix 1 preserves the PDF but the customer still does not get
their email, and the automations still do not fire.

## Open item

Q-1010's stored `signedPdfHash` refers to bytes that no longer exist. If a
rebuilt PDF is ever filed against this request, the original hash should be kept
on record rather than overwritten — the mismatch is the honest state, and hiding
it would make the record claim more than it can support.
