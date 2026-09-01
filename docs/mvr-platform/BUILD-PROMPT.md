# Build prompt — MVR Communication System

Paste everything below the rule into a fresh Claude Code session opened on an **empty
repository**, and attach `MVR_Communication_System_Overview.pdf` to that session. This
brief restates the document, but the document governs.

Fill in the three bracketed values at the top before you send it.

---

You are starting the **MVR Communication System** for Michean Van Riel Interiors (Pty)
Ltd, a high-end interior design practice in South Africa. Read this entire brief before
writing a single file. Read the attached source document too — it is the practice's own
working overview of the process this platform has to serve. When you are ready, produce
a plan and wait for approval. Do not scaffold on the strength of this message alone.

**This build is the foundation plus one module.** Not the platform. Section 0.5 defines
the scope and it is binding; sections 1 to 7 exist so that the foundation you lay is the
right shape for what comes later.

## 0. The variables

- **Expected scale year one:** `[e.g. 8 staff, 25 active projects, 60 client users]`
- **Deployment target:** `[e.g. Vercel + Neon eu-central; or AWS af-south-1]`
- **Data residency:** `[South Africa unless stated otherwise — POPIA applies either way]`

Ask for any that are blank before planning. Everything else here is decided.

## 0.5 The scope of THIS build — read this twice

This prompt does **not** build the MVR Communication System. It builds **the foundation
and exactly one module**, as a proof that the foundation is right before anyone commits
to the rest.

- **Sections 1–7 are context, not a work list.** They describe the whole system so that
  the foundation you lay now — the security model, the module boundaries, the data
  model, the design system — does not have to be torn up in three months. Read them to
  understand what you are building *towards*. Do not build them.
- **Section 8 is the work list.** The kernel, full user access control, one module —
  the **Introduction Phase**, which is the practice's client onboarding process, end to
  end — and a **deliberately narrow client portal** that exists to demonstrate it.
- **Section 8.5 lists what is explicitly out of scope.** It is longer than the work list.
  That is intentional.

Do not build a second module because it looked quick. Do not stub screens for phases
that are out of scope. Do not widen the portal beyond the five screens in section 8.4.
Do not add a dashboard nobody asked for. **If you finish early, deepen the tests, or make the
onboarding experience better** — those are the two things this build is being judged on.

The build has exactly two measures of success. First: whether module two can be built
entirely inside the seams this one creates, without touching the kernel. Second: whether
Michean can put the onboarding flow in front of a prospective client and have it raise
her practice rather than embarrass it.

## 1. What this is

One platform holding the whole life of a project, from first enquiry to close out. It
has three pillars, and they are not equally weighted.

**The spine is internal team communication.** The design process — Conceptual,
Scheming, Costing, Supplier Communication, Technical — is predominantly internal work,
and today that conversation is scattered across WhatsApp, calls and inboxes. The
platform's central job is to hold that conversation *against the project*, so the
practice has a single internal view of where every project stands and why. Every other
feature exists to give that conversation something to be about.

**The structure is a gated project journey.** Eleven phases, each with entry conditions
that must actually be met before a project advances. This is what turns a chat log into
a managed process.

**The face is the client portal.** Clients see progress, receive updates, read and sign
documents, upload proof of payment, and make the decisions the process asks of them —
and see nothing else, ever.

The document is explicit that this does **not** replace personal contact: calls,
meetings and WhatsApp continue. The platform is the *record* — where decisions,
documents and progress live, whatever channel the conversation happened on.

## 2. The project journey — the core domain

Eleven phases:

**Introduction → Conceptual → Scheming → Costing → Supplier Communication → Technical →
Implementation → Manufacturing → Production → Snagging & Finishing → Close Out**

Client communication changes character across them, and the system must know which
regime it is in:

| Phases | Client experience |
| --- | --- |
| Introduction | Intensive, personal, high-touch onboarding |
| Conceptual → Technical | Predominantly internal work; client receives **automated or milestone** updates |
| Implementation | Client chooses their level of MVR involvement; monthly invoicing cycle |
| Manufacturing → Close Out | **Personalised weekly updates** as physical results appear |

### 2.1 Introduction Phase, in detail

**1. Contact.** A representative creates a client profile and a project under it, then
captures, as mandatory fields before the project may advance: what the client wants to
achieve; the scope (areas of the home and work required — wall panelling, furniture,
wallpaper, lighting, electrical, flooring, painting and similar); approximate size of
the project area; style inspiration and preferred direction; **photographs and videos of
the existing space plus inspiration images**; the client's intended timeline; the floor
plan (or a note that measurements will be taken on site); and a booked in-person
consultation. Current channel: WhatsApp and direct calls.

**2. Consultation**, 3–7 days after contact, in two parts. *Part One* on site:
photographs, videos, measurements where no adequate floor plan exists, and scheduling of
Part Two. *Part Two* online: budget and timeline. Then MVR reviews and either approves
or denies.

- **Approved** → the client is issued portal access and moves on.
- **Denied** → a professionally worded explanation; where appropriate the client is
  retained in the MVR database with **a reminder six months out** for a consultant to
  revisit.

**3. Design Proposal.** Phase 1 (Interior Design and Full Technical Documentation) is
mandatory; Phase 2 Implementation Services is optional with **Option A or Option B**.
The proposal is shared; an invoice for the Phase 1 commencement fee is issued with
banking details; the client **uploads proof of payment**; MVR **verifies receipt** before
the project advances. The client may opt into Phase 2 here — and if they decline, they
are asked again when the project reaches Implementation.

**4. Onboarding document.** Issued to the client, who must **sign and complete** it.
Only then does the project enter Conceptual.

### 2.2 The internal phases

Conceptual, Scheming, Costing, Supplier Communication and Technical share a shape:
internal progress and team conversation recorded against the project and visible to the
relevant MVR members, with the client receiving an appropriate automated or milestone
update as things move. **Supplier Communication** additionally makes suppliers
first-class: supplier correspondence and project-specific supplier information linked to
the project, with the client updated where supplier progress materially affects them.

### 2.3 Implementation onward

**Implementation:** the client selects their Phase 2 option (or is asked again if they
passed earlier); invoices are issued **monthly**; the client uploads proof of payment
monthly; MVR verifies and maintains the payment record.

**Manufacturing, Production, Snagging & Finishing:** internal progress recorded, and a
**personalised weekly update** to the client — personalised, meaning written by a human,
not generated.

**Close Out:** final snagging and outstanding actions complete, final documents retained,
final payment status confirmed, project marked complete — and the client and project
remain in the database for future reference and appropriate relationship or marketing
communication.

### 2.4 How to model this — read carefully

The source document is a **working overview**, not a frozen specification. The phases,
their required fields and their gates *will* change. So:

- **The journey is data, not control flow.** A journey definition holds the ordered
  phases and, per phase, its entry requirements: required fields, required artifacts,
  required approvals, required verified payments. Advancing is a single transition
  operation that evaluates the gate, refuses with a legible list of what is missing, and
  writes an audit record of who advanced it and when.
- **Journey definitions are versioned, and a project pins the version it started under.**
  Editing the journey must never retroactively invalidate a project in flight.
- **`if (project.phase === 'COSTING')` scattered through the codebase is the failure
  mode.** Behaviour that varies by phase is looked up from the phase definition —
  including which client-communication regime applies.
- **Gates are evaluated server-side and enforced at the data layer.** A phase advance
  that skips a gate must be impossible, not merely absent from the UI.

## 3. The four constraints that outrank everything

### 3.1 The wall between internal and client-visible

This is the highest-stakes decision in the product, and it is settled: **internal
conversation and client-facing communication are separate object types, in separate
tables, with separate policies and separate routes.** A client-visible thread cannot
physically hold an internal message. There is no `isInternal` boolean deciding it,
because a boolean is one bad default, one careless join or one sloppy migration away
from showing a client what the team said about their budget.

Surfacing something internal to the client is an explicit act that **creates a new
published object** — staff compose or promote content into a client-facing update. The
internal original stays internal.

This wall runs through everything, including the parts that are easy to forget: search
indexes, notification emails, exports, activity feeds, webhooks, and any AI feature that
ever summarises a project. Write the hostile tests for all of them.

### 3.2 Secure by construction

A client sees their project and nothing else, and that holds even when a route handler
is written carelessly on a Friday. Security lives in layers that never depend on the
caller remembering:

1. **Postgres row-level security** as the last line. The application connects as a role
   with RLS enforced; scoped tables carry policies keyed off session variables set at
   connection checkout. A query that forgets its `WHERE` returns nothing, not everything.
   Prove it with a test before the second feature exists.
2. **A request-scoped data accessor.** No route or server action touches the raw client;
   they receive a context carrying the authenticated principal, and all access goes
   through accessors that cannot be constructed without one. Enforce with a lint rule
   that fails the build on direct import outside the data layer.
3. **Deny-by-default authorisation** through a central `can(principal, action, resource)`
   policy layer. New resources are unreachable until a policy exists.
4. **Two identity domains.** Staff and client users are different principal types with
   different cookies, lifetimes and rate limits, and no code path promotes one into the
   other. Access to a project is granted per membership — never globally, never by role
   alone.
5. **Append-only audit.** Who viewed which document, who verified a payment, who
   advanced a phase, who published an update, who signed what. No update or delete path
   exists in the application. For a practice invoicing against signed proposals, this is
   the product.

Then the baseline: argon2id password hashing, opaque server-side sessions, CSRF on every
mutation, a real CSP with no `unsafe-inline`, strict security headers, per-route rate
limiting, environment validated at boot, secret scanning in CI from day one, structured
logs carrying ids and never PII or file contents, scheduled dependency updates.

**Uploads and money need their own paragraph.** Clients upload proof of payment — an
unauthenticated-adjacent file arriving from outside, attached to a financial decision.
So: private object storage only, never a public bucket; short-lived signed URLs minted
only after an authorisation check and bound to the principal they were issued to; content
type sniffed from bytes, never trusted from the extension or header; checksums stored;
anything active (SVG, HTML, PDF with embedded JS) stripped or quarantined; a documented
seam for malware scanning. Payment *verification* is a human decision with financial
consequence: it is recorded with actor, timestamp and evidence, it is immutable, and
reversing it is a new record rather than an edit.

POPIA applies. Client photographs of private homes are personal information. Retention,
export, and deletion-on-request need to be designed in, not bolted on — and the Close Out
requirement to retain projects for future marketing communication needs a lawful basis
and an opt-out recorded against the client.

### 3.3 Modular

Modular structurally, or it will not survive a deadline.

- **A kernel that knows nothing about modules:** identity, sessions, authorisation,
  tenancy, audit, storage, media processing, notifications, jobs, real-time transport,
  search, the design system. The kernel never imports a module.
- **Modules own their slice** — schema, policies, routes, UI, migrations, tests — and
  declare it in a manifest: id, name, dependencies, navigation and portal surfaces,
  policy actions, jobs, migrations. Composition happens through the registry; modules
  never reach into each other's internals, only published contracts.

  ```
  modules/
    onboarding/   portal/       ← this build
    projects/     journey/      comms/        updates/
    documents/    suppliers/    finance/      tasks/
    selections/   snagging/     ← later, not now
  ```

  The names beyond `contact` are indicative, not a commitment. Propose the boundaries you
  think are right — but propose them, because module one's shape is only defensible in
  relation to the ones that follow it.

- **Modules are switchable per deployment.** Disabling one removes its routes,
  navigation, jobs and portal surfaces and leaves an app that builds, passes tests and
  renders no dead links. Prove it with a test that boots with an empty module set.
- **Enforce boundaries in CI** with a dependency-direction rule that fails the build.
  Conventions decay; failing checks do not.

Three things are **seams, not features**, in the first build — build the joint, ship one
thin real consumer, document the intended shape in `docs/seams.md`, and stop:

| Seam | Why it must exist now |
| --- | --- |
| **External capture** | Email, WhatsApp, calls and meeting notes will need to be pulled into the project record. Not yet scoped. Build a `CaptureAdapter` — normalised inbound message, participant resolution, project attribution, deduplication — and implement exactly one (inbound email) to prove it. |
| **Annotation** | Comments pinned to a coordinate on a floor plan, a render or a photograph, revision-aware. Media and documents must expose stable page/region addressing from the start. |
| **Structured selections** | Finishes, fabrics, fixtures, hardware — an option set presented to the client, a selection, a lock date, a cost, a supplier. Absent from the source brief, but for an interiors practice this is close to the centre of the client relationship and it will be asked for. It attaches to scope items, so make sure they can carry it. |

### 3.4 Visually exceptional

For an interiors practice, imagery *is* the product. The interface has to be the calibre
of the work it displays.

The brand identity is supplied by the practice and is not yet in hand, so:

- **Every visual value is a token** — colour, type scale, spacing, radii, shadow, motion.
  A hex code, font name or magic pixel value inside a component is a defect; add a check
  that greps for them and fails.
- **Brand is runtime configuration** — palette, typefaces, logo, wordmark, radius,
  density — resolved once into CSS custom properties. Swapping it is one config change.
  Validate the palette on the way in (it lands in a stylesheet; it is untrusted) and
  *derive* readable foregrounds from luminance rather than storing them, so no supplied
  brand can produce unreadable text.
- **The default brand is a finished, restrained neutral** — near-black ink, warm paper
  white, one accent, a fine serif for display against a precise grotesque for interface —
  that looks deliberate on day one and disappears when the real identity lands.
- **Media handling is a first-class subsystem, not an `<img>` tag.** Photographs, videos
  of existing spaces, inspiration imagery, moodboards, floor plans, progress photography.
  That means: resumable direct-to-storage uploads that survive a phone on site with bad
  signal; derivatives generated off the request path; AVIF and WebP at DPR-aware widths,
  never upscaled; blur or dominant-colour placeholders; colour profiles preserved; EXIF
  orientation respected and GPS **stripped**; video delegated to a managed platform with
  signed playback. Section 6 specifies how. A soft image on a Retina display fails this
  brief as badly as a broken link.
- **Typography and space carry the design**, not chrome. A modular scale, real rhythm,
  generous margins, hairline rules. Restraint reads as expensive.
- **Motion is functional and fast** — 150–250ms, entrances and state changes only, fully
  honouring `prefers-reduced-motion`.
- **Two surfaces, one system.** Staff get a dense, keyboard-driven working environment;
  clients get a calm, near-editorial reading experience. Same tokens, same components,
  different density — controlled by a density token, not a forked component library.
- **WCAG 2.2 AA is a floor, verified in CI.** The portal must be genuinely good on a
  phone; the site-capture flow must be usable one-handed on site.

## 4. Internal communication — the spine

The practice intends to **move off its current chat tools in phases**. That does not
mean building Slack in week one; it means never building anything that would have to be
thrown away to get there. Async-first in the first release, with the transport, data
model and permission model already correct for real-time.

Four shapes, all of them internal-only:

1. **Threads anchored to objects** — a discussion attached to a document revision, a
   milestone, a costing item, a supplier, a media asset. This is what chat cannot do and
   what makes the record defensible. Polymorphic anchoring, resolved through the module
   registry so a module can declare its types discussable without the comms module
   knowing they exist.
2. **Project channels** — a running conversation per project, where joining a project
   grants its history.
3. **Direct and small-group messages** — person to person, not attached to a project.
   These need the strictest access rules in the system: never visible to any client
   principal under any circumstance, never surfaced in a project export.
4. **Tasks and requests** — a message that is also an accountable item with an owner, a
   due date and a state, rolling up to a per-person dashboard. This is how "the team is
   working on it" becomes something a director can see.

Design for the endgame from the start: a message model that carries edits, reactions,
attachments and threading; a real-time transport (websocket or equivalent) with
authorisation on subscribe, not just on read; unread and mention state per user;
notification preferences and digests; and **permission-filtered search** — filtering at
query time, never post-filtering results, because a search index is the most common way
an access-control model gets quietly bypassed.

## 5. Client-facing updates — the other half

Two distinct regimes, one publishing model.

- **Milestone and automated updates** during the internal phases. Triggered by phase
  advance or a defined event, composed from a template. **Critical:** an automated update
  may interpolate only fields explicitly marked client-safe. It never reads internal
  threads, internal notes, or anything not marked for publication. Default to requiring
  staff approval before send; allow genuinely mechanical notices (a phase advance) to go
  unattended only where the template contains no free text.
- **Personalised weekly updates** during Manufacturing, Production, and Snagging &
  Finishing. Written by a named human. The system's job is to make sure it happens: a
  scheduled obligation against a named owner, escalating when overdue, visible as a
  metric. A practice that promises weekly updates and misses them is worse off than one
  that never promised.

Every published update is an object with an author, a publication state, an audience and
an audit trail. Drafts are invisible to clients — prove it in the test suite.

## 6. Stack

This is decided, not a starting suggestion. It mirrors a production system the practice's
developer already runs, which means its failure modes are known rather than theoretical.
Justify any deviation in `docs/adr/0001-stack.md` before writing code.

### 6.1 The core

- **Next.js (latest stable), App Router, React, TypeScript strict**
- **PostgreSQL** — non-negotiable; RLS is the security model. Neon or equivalent managed
  Postgres, with a role that has RLS enforced and is **not** the schema owner.
- **Prisma** for schema and migrations, with raw SQL migrations for policies and anything
  Prisma cannot express
- **Tailwind CSS v4** driven entirely by the token layer, plus Radix primitives and a
  small owned component set — no wholesale UI framework that will fight the brand later
- **Zod** at every trust boundary: request bodies, forms, environment, webhooks, and
  external API responses
- **Own the authentication.** Opaque server-side sessions, `jose` for token handling,
  **argon2id** for password hashing (bcrypt is acceptable if it matches existing
  practice, but argon2id is the better default), and **passkeys for staff** — WebAuthn is
  a better fit than passwords for a small team that logs in daily, and it removes a whole
  class of credential risk.
- **Vercel** for hosting, in the region closest to the practice with acceptable latency.
  Database region matters far less than media edge presence — see 6.3.
- **Vercel Cron plus a database-backed outbox** for background work. Events are written
  in the same transaction as the change that caused them and drained by a scheduled
  endpoint, so nothing is lost when a request dies. Retries and idempotency are required,
  not optional.

### 6.2 Files do not live in the database

**Nothing binary goes into Postgres.** No `bytea` columns, no base64. The database stores
*rows about* files — storage key, checksum, MIME type, byte size, dimensions, duration,
derivative references, uploader, project, client visibility — and object storage holds the
bytes. A video in a database column bloats every backup and every replica, and still
cannot be streamed, because scrubbing needs HTTP range requests.

- **Documents and images: object storage, private by default.** Vercel Blob is adequate
  and simple; Cloudflare R2 is the alternative if egress cost becomes visible, since a
  client portal serves the same imagery repeatedly. Sit both behind the `StorageAdapter`
  so the choice is a swap, not a migration.
- **Upload direct from the browser to storage.** File bytes never pass through a route
  handler — it is slow, it is expensive, and serverless request body limits will stop it
  anyway. Mint an upload token server-side after an authorisation check; the client
  uploads to storage; the server records the resulting object.
- **Uploads must be resumable.** A designer is standing in a client's lounge on one bar of
  signal. A dropped upload resumes; it does not start again.
- **Serve through an authorising route**, which checks access and then redirects to a
  short-lived signed URL bound to the requesting principal. No public buckets. Never a
  storage URL in a page's HTML.

### 6.3 Video is a specialist problem — delegate it

Site walkthroughs shot on a phone are a first-class input to this system, and the naive
implementation fails badly.

**Use a managed video platform — Cloudflare Stream or Mux. Do not build a transcoding
pipeline.** Both provide, in one integration: `tus` resumable direct upload from the
phone, transcoding, adaptive-bitrate HLS, poster frames, and — critically — **signed
playback tokens**, so a client's video is unplayable by anyone the platform has not
authorised. Cloudflare Stream is cheaper and simpler and has South African edge presence;
Mux is preferable if engagement analytics are ever wanted. Either way the practice's own
database stores only the asset id, the playback policy, and the metadata.

**Do not transcode on the application host.** ffmpeg inside a serverless function will
hit memory and duration limits, and you would be paying compute rates to do a worse job.

Ingest completion arrives by **webhook**, which must be signature-verified, idempotent,
and unable to change anything about a project beyond the media asset it names.

### 6.4 Images: pre-generate, do not optimise on the fly

Private storage plus short-lived signed URLs composes badly with an on-the-fly image
optimiser, which needs to fetch the original itself. Instead, generate derivatives with
`sharp` in a background job at fixed widths, in AVIF and WebP, and store them beside the
original. Deterministic, no per-transformation billing, and it works with the access
model rather than around it. Strip GPS, honour EXIF orientation, preserve colour profile,
never upscale.

### 6.5 Two operational things that are not optional

- **Backups must cover the blob store, not only the database.** A database backup without
  the files it references is not a backup, and the failure is silent until the day it
  matters. Verify coverage on a schedule; a backup that has never been restored is a
  hypothesis.
- **RLS and connection pooling interact badly, and the bug is the worst one available.**
  With a pooler in transaction mode, session-level settings do not survive between
  requests, so tenant context must be set with `SET LOCAL` **inside the transaction** that
  uses it. Set it at session level and a pooled connection will eventually serve one
  workspace's data under another's context. Write the test that proves the context cannot
  leak between transactions before you rely on RLS for anything.

**Read the installed documentation before writing code against any of these.** Framework
majors move faster than training data; `node_modules/<pkg>/` and the docs for the
*installed* version are the source of truth. When the installed version disagrees with
what you remember, the installed version is right.

## 7. Domain model

**Workspace scoping from day one.** Every table carries a workspace id and every policy
keys off it, even though this launches for one practice. It costs almost nothing now and
is close to impossible to retrofit. Argue it in an ADR if you disagree — before building.

- **Client** — the profile: people, contact details, source, marketing consent, status
  (prospect / active / archived / revisit-due).
- **Enquiry** — first contact through the approve/deny decision, carrying the mandatory
  contact-stage fields, the consultation bookings, and the denial outcome with its
  six-month revisit reminder.
- **Project** — created under a client; the scoping root for everything below. Carries
  its journey version, current phase, size, timeline, style direction.
- **ProjectArea** and **ScopeItem** — the project decomposes by *area of the home* and,
  within each, the *work required*: wall panelling, furniture, wallpaper, lighting,
  electrical, flooring, painting. This is not a text field on the project. Costing,
  supplier engagement, manufacturing, production and snagging all key off scope items,
  and every one of the physical phases is really a state machine running per item rather
  than per project. Get this wrong and the Costing and Manufacturing phases have nothing
  to attach to.
- **ProjectMembership** — for staff *and* for clients, separately typed. The only thing
  granting a client any visibility.
- **PhaseDefinition / JourneyVersion / PhaseTransition** — the stage machine of §2.4.
- **Milestone** — a programme item with dates, status and client visibility.
- **MediaAsset** — photograph, video, inspiration image, floor plan, moodboard item;
  derivatives, checksum, capture context, EXIF handling, client visibility.
- **Document / DocumentRevision / DocumentIssue** — the document is the identity, the
  revision is the file; revisions immutable, numbered, checksummed; issuing records who
  sent what to whom and why. Superseding never destroys.
- **Signature** — the signed onboarding document and anything else requiring assent:
  signer, artifact, evidence, timestamp.
- **Update** — a published client-facing post: author, body, attachments, audience,
  publication state, regime (automated / milestone / weekly personalised).
- **Thread / Message / Channel / DirectConversation** — internal only, per §4.
- **Task** — owner, due date, state, origin; assignable to staff, and separately, a
  **ClientAction** for what the portal asks of the client (upload POP, sign onboarding,
  choose Option A or B, supply information).
- **Supplier / SupplierEngagement** — supplier records and their project-linked
  correspondence, engaged against scope items.
- **SnagItem** — Snagging & Finishing is a named phase, so the snag list is an entity,
  not a note: area, scope item, description, photograph, owner, state, date resolved.
  Close Out asserts that every one is closed.
- **Proposal / ProposalOption** — Phase 1 and the optional Phase 2 with Options A and B,
  including the deferred re-offer at Implementation.
- **Invoice / ProofOfPayment / PaymentVerification** — issuance, client upload, staff
  verification, monthly recurrence during Implementation.
- **AuditEvent** — actor, action, resource, metadata, timestamp. Append-only.
- **Principal** — `StaffUser` and `ClientUser`, sharing nothing but a contact record.

**Model client visibility explicitly on every client-facing object**, and default it to
hidden. Never infer visibility from the absence of a flag. The worst possible failure of
this product is a client seeing an internal cost discussion, an unissued drawing, or
another client's home.

## 8. The work — foundation, access control, onboarding, demo portal

### 8.1 The foundation

1. **Repository and CI.** Strict TypeScript, lint, formatting, environment validation at
   boot, secret scanning, and a single `npm run verify` that CI runs on every push.
2. **Database and tenancy.** Postgres, workspace scoping on every table, RLS enabled and
   **proven by test** — the application role must not be able to bypass it.
3. **The access layer.** Request-scoped data accessor no route can bypass, enforced by a
   lint rule; deny-by-default `can(principal, action, resource)` policy layer.
4. **Audit.** Append-only, with no update or delete path in the application.
5. **Storage and media**, per section 6.2–6.4. Private object storage behind a
   `StorageAdapter`; resumable direct-from-browser uploads; an authorising route that
   redirects to short-lived signed URLs bound to the requesting principal; byte-level
   content sniffing; checksums; EXIF orientation honoured and **GPS stripped**;
   `sharp` derivatives generated in a job; video delegated to Cloudflare Stream or Mux
   with signature-verified, idempotent ingest webhooks and signed playback.
6. **Jobs and transactional email.** A real job runner with retries and idempotency;
   outbound email for invitations and notifications. Nothing slow runs in a request.
7. **The module registry.** Manifests, boundary lint, and the test that boots the app
   with an empty module set.
8. **A gate primitive.** Generic requirement evaluation: given declared requirements and
   a subject, return what is satisfied and what is missing. Modules declare requirements
   into it; the kernel knows nothing about phases.
9. **The journey definition as data.** All eleven phases declared, versioned, with a
   project pinning its version — but only the Introduction Phase's requirements
   populated. The other ten are named and empty.
10. **The design system.** Tokens, brand injection, the neutral default brand, the base
    component set, and both density modes — staff and client.

### 8.2 User access control — in full, from the start

This is foundation, not a feature, and it ships complete:

- **Two principal types**, `StaffUser` and `ClientUser`, with separate session audiences,
  separate cookies, separate lifetimes, and no code path that promotes one into the other.
- **Staff roles** as *capabilities*, not role-string comparisons scattered through the
  code. `can(principal, action, resource)` is the only question anyone asks. Start with
  three roles — director, designer, coordinator — and make adding a fourth a data change.
- **Per-project membership** for staff *and* clients, separately typed. Membership is the
  only thing that grants access to a project. A director's elevated capabilities still do
  not make them a member of every project by accident — decide that explicitly and write
  the decision down.
- **A staff administration surface**: invite a team member, assign their role, add and
  remove them from projects, deactivate them. Invitations are single-use, expiring, and
  audited.
- **Client access issued deliberately.** Under the source process a client receives portal
  access only once their consultation is approved. Model that as an explicit grant with an
  actor and a timestamp — never as a side effect of a record existing.
- **Every access decision audited**: grants, revocations, role changes, and denied
  attempts.

### 8.3 Module one — `onboarding`: the Introduction Phase, end to end

The practice's client onboarding process, from first contact to the signed onboarding
document, exactly as the source document describes it.

**1. Contact.** Create a client profile with contact details; create a project under that
client; capture the mandatory intake — what the client wants to achieve, the scope as
**areas of the home with the work required in each** (wall panelling, furniture,
wallpaper, lighting, electrical, flooring, painting and similar), approximate size,
style inspiration and preferred direction, the client's intended timeline, and the floor
plan or an explicit record that measurements will be taken on site. **Photographs and
videos of the existing space and inspiration images upload from a phone, on site, on a
poor connection** — this is the hardest part of the module and the part most often done
badly. Book the in-person consultation.

**2. Consultation.** Part One on site and Part Two online, each scheduled against the
project with an attending representative; capture on-site photographs, videos and
measurements; record budget and timeline from Part Two. No calendar integration.

**3. The decision.** Approve or deny.
- **Approved** → the client is granted portal access and invited by email.
- **Denied** → a professionally worded explanation from a template, the client retained
  in the database, and **a reminder scheduled six months out** for a consultant to revisit.
  Build the reminder as a real scheduled job, not a flag someone has to notice.

**4. Design Proposal.** Issue the Phase 1 proposal document with the commencement-fee
invoice and banking details. The client uploads **proof of payment**; a staff member
**verifies receipt** — an audited, immutable decision with financial consequence, where
reversing it writes a new record rather than editing the old one. The client may opt into
**Phase 2, Option A or Option B**, or defer, in which case the deferral is recorded so the
Implementation Phase can ask again.

**5. Onboarding document.** Issued to the client, who **signs** it. A signature is a
record of assent with signer, artifact hash, timestamp and evidence — not a picture of a
name. Typed or drawn is fine; the integrity of the record is what matters. On completion,
the Introduction Phase's gate is satisfied and the project may advance to Conceptual.
Where it advances *to* is out of scope: Conceptual is an empty phase in this build.

Every step above declares its requirements into the gate primitive, so the phase cannot
be completed with anything outstanding, and every step is audited.

### 8.4 The demonstration portal — narrow, and exceptional

The portal exists in this build to demonstrate onboarding, and to prove the wall. It has
**five screens and no more**:

1. **Invitation and first sign-in** — the client's first contact with the practice's
   software.
2. **Project overview** — where their project is, what has happened, what happens next.
3. **The proposal** — read the document, see the fee, see the banking details, choose
   Phase 2 Option A or B or defer.
4. **Actions** — what the practice needs from them: upload proof of payment, sign the
   onboarding document. Clear, singular, impossible to misread.
5. **Documents** — what has been issued to them, downloadable through a signed URL.

No messaging, no gallery, no history feed, no settings beyond the minimum, no notification
preferences.

**This is the part that has to be visually stunning**, and "stunning" here means specific
things rather than more decoration:

- **The first sign-in is the moment the practice is judged.** A client who has just paid a
  commencement fee for interior design opens this on a phone, probably in the evening. It
  should feel like the practice, not like software.
- **Their own photographs are the page.** The imagery captured during Contact is the
  material — full-bleed, colour-accurate, sharp on a Retina screen, never upscaled, never
  letterboxed into a card. An interiors client's own home, well presented, is worth more
  than any illustration.
- **Progress reads at a glance.** Eleven phases is a lot; show where they are and what is
  next without a chart that looks like project-management software. Restraint.
- **The two asks are unmistakable.** Uploading proof of payment and signing the onboarding
  document are the only things the client must do. They should be obvious in a glance and
  finishable in under a minute, including on a phone.
- **Signing feels considered, not transactional.** It is the moment the relationship
  becomes formal.

The brand identity is not yet available, so all of this must be stunning **in the neutral
default brand** and must survive the real identity being dropped in later. Type, space,
imagery and restraint — not colour and effects.

### 8.5 Explicitly NOT in this build

Everything from the Conceptual Phase onward: Conceptual, Scheming, Costing, Supplier
Communication, Technical, Implementation, Manufacturing, Production, Snagging & Finishing
and Close Out. Internal messaging, channels, threads, direct messages, tasks and requests.
Client-facing updates of any kind, milestone updates, automated updates and the weekly
update engine. Suppliers. Snagging. Structured selections. Annotation and markup. Email
or WhatsApp capture. Monthly Implementation invoicing. Payment gateways. Search. Real-time
delivery. Mobile apps. AI features. Reporting and analytics. Any portal screen not listed
in 8.4.

Every one of these has a seam or a section above describing where it will attach. None is
built now. If you believe one is genuinely required to make onboarding work, say so in
your first response and argue it — do not quietly include it.

### 8.6 Definition of done

A person can sign in as MVR staff, invite a colleague and set their access, create a
client, create a project, complete the intake with photographs and video taken on a
phone, book and record both parts of the consultation, approve the client, watch the
invitation arrive, and then — as that client, on a phone — sign in, read the proposal,
choose a Phase 2 option, upload proof of payment and sign the onboarding document, while
staff verify the payment and see the phase gate close. A denied client instead receives
their explanation and appears six months later on someone's list.

And all of this passes in `npm run verify`:

- A query run without workspace context returns zero rows. RLS proven, not assumed.
- A client sees their own project and **nothing else** — no other client, no other
  project, no internal field, no unissued document — via API, server action, an id in a
  URL, an export, an email, or a signed URL minted for someone else.
- A staff member without project membership cannot reach that project's data, whatever
  their role.
- A session of one audience is rejected when presented for the other.
- A client principal cannot reach any staff route, and revoking access takes effect
  immediately on the next request, not at session expiry.
- The Introduction Phase cannot be completed with an unmet requirement, through any path,
  including one that calls the transition directly.
- Payment verification and signature records cannot be edited or deleted through any
  application path.
- Uploads whose declared type does not match their bytes are rejected; GPS is stripped
  from every stored photograph; signed URLs expire and are bound to their principal.
- Every mutating route rejects a request without CSRF protection.
- The app builds and all tests pass with the optional modules disabled.
- No component contains a raw colour, font name or magic pixel value.
- Contrast, keyboard navigation and focus order pass automated accessibility checks; the
  intake, upload, payment and signing flows are all usable one-handed on a phone.

A control without a test that fails when the control is removed is not done.

## 9. How to work

- **Plan before building.** Produce the module list, the schema, the journey definition
  and the security model as documents. Get them approved. Then build.
- **Small, coherent commits** with messages explaining *why*.
- **Write decisions down** in `docs/adr/`. Comments explain reasoning the code cannot.
- **Every security control needs a test that fails when the control is removed.** An
  untested control is a comment.
- **Never weaken a check to make something pass** — not the type checker, not the lint
  rule, not the CSP, not a test. If a control is wrong, change it deliberately, in its
  own commit, with the argument written down.
- **A fix for a defect found in review targets the main branch**, not the branch that
  introduced it. A stacked fix is safe only while its base is unmerged, and nothing
  watches for that changing. After any merge, verify the change reached the branch that
  deploys.
- **Ask when the answer changes the architecture; assume, and say so, when it does not.**

## 10. Your first response

Do not write code yet. Reply with:

1. **A one-line confirmation of scope**: the foundation, full access control, the
   `onboarding` module, the five-screen demonstration portal, and nothing from 8.5.
2. Anything contradictory, under-specified, or over-engineered for the stated scale —
   including anything in the source document you think will not survive contact with how
   the practice actually works, and anything in section 8.5 you believe onboarding
   genuinely cannot work without.
3. Your proposed module boundaries for the whole system, and the schema for this build.
4. The journey definition as data: the eleven phases, how Introduction's requirements are
   declared by the `onboarding` module, and how a transition is evaluated and refused.
5. The security model: RLS policy shape, principal types, session design, the capability
   and membership model, and specifically how the internal/client wall is enforced in the
   database rather than in application code.
6. **How you intend to make the onboarding experience and the portal genuinely
   exceptional** — the visual direction, the two or three moments you will spend
   disproportionate effort on, and what you will deliberately leave plain. This is half
   of what the build is judged on; treat it with the same seriousness as the schema.
7. The token architecture and how a supplied brand is injected later without a rework.
8. The build order, and what you need from me at each step.
