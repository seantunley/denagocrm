# Build prompt — MVR Communication System

Paste everything below the rule into a fresh Claude Code session opened on an **empty
repository**, and attach `MVR_Communication_System_Overview.pdf` to that session. This
brief restates the document, but the document governs.

Fill in the three bracketed values at the top before you send it.

---

You are building the **MVR Communication System** for Michean Van Riel Interiors (Pty)
Ltd, a high-end interior design practice in South Africa. Read this entire brief before
writing a single file. Read the attached source document too — it is the practice's own
working overview of the process this platform has to serve. When you are ready, produce
a plan and wait for approval. Do not scaffold on the strength of this message alone.

## 0. The variables

- **Expected scale year one:** `[e.g. 8 staff, 25 active projects, 60 client users]`
- **Deployment target:** `[e.g. Vercel + Neon eu-central; or AWS af-south-1]`
- **Data residency:** `[South Africa unless stated otherwise — POPIA applies either way]`

Ask for any that are blank before planning. Everything else here is decided.

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
    clients/      enquiries/    projects/     journey/
    comms/        updates/      documents/    media/
    suppliers/    finance/      tasks/        portal/
  ```

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
  signal; server-side derivative generation off the request path; AVIF and WebP at
  DPR-aware widths, never upscaled; blur or dominant-colour placeholders; colour profiles
  preserved; EXIF orientation respected and GPS **stripped**; video transcoded with
  poster frames. A soft image on a Retina display fails this brief as badly as a broken
  link.
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

Start here; justify any deviation in `docs/adr/0001-stack.md`.

- **Next.js (latest stable), App Router, TypeScript strict**
- **PostgreSQL** — non-negotiable; RLS is the security model
- **Prisma** for schema and migrations, with raw SQL for policies and anything Prisma
  cannot express
- **Tailwind CSS v4** driven entirely by the token layer, with a small owned component
  set — no wholesale UI framework that will fight the brand later
- **Zod** at every trust boundary: request bodies, forms, environment, webhooks, external
  API responses
- **Argon2id** passwords, opaque server-side sessions
- **Object storage with direct, resumable uploads**, private by default
- **A real background job runner** with retries and idempotency — email, derivatives,
  transcodes, scans, scheduled reminders and digests never run inline in a request

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

## 8. What to build first

**Phase 0 — hardened walking skeleton.** One vertical slice, end to end:

1. Repository, CI, environment validation, secret scanning, formatting, strict lint.
2. Kernel: database with RLS proven, scoped accessor, policy layer, staff auth, client
   auth, audit, storage adapter, media pipeline, job runner, design tokens, base
   components.
3. Module registry, manifests, boundary lint, empty-module-set boot test.
4. `clients` + `projects`: create a client, create a project under them, add staff and
   client members.
5. `journey`: the eleven phases as a versioned definition, with gate evaluation and
   audited transitions.
6. `comms`: project channels and object-anchored threads, internal only, with the wall
   tested from every angle.
7. `media` + `documents`: upload from a phone on site, derivatives, revisions, issue to
   client, signed download.
8. `updates`: draft, publish, client reads it.
9. `portal`: login, project overview, phase progress, documents, updates, and the
   client's outstanding actions. Beautiful — this screen is the product demo.

**Phase 1:** the full Introduction Phase including consultation scheduling, approve/deny
with the six-month revisit reminder, proposal, invoice, POP upload and verification,
onboarding signature. Then tasks and requests, suppliers, and the weekly update
obligation engine.

**Phase 2:** direct and group messaging, real-time delivery, presence, mobile push,
search — the path off the practice's current chat tools.

**Phase 0 is not done until a hostile test suite passes**, written alongside the
features rather than after:

- A client cannot read another project's data — via API, server action, an id in a URL,
  or a signed URL minted for someone else.
- A query without tenant context returns zero rows. RLS proven, not assumed.
- No internal thread, message, note or task is reachable by any client principal —
  through the portal, an export, a notification, a webhook or search.
- Drafts and unissued revisions are invisible to clients.
- A staff session cookie cannot authenticate a portal route, or the reverse.
- A phase cannot advance with an unmet gate, through any path.
- An automated update composed from a project with internal notes contains none of them.
- Signed URLs expire and are bound to their principal.
- Every mutating route rejects a request without CSRF protection.
- Uploads with mismatched declared and actual content type are rejected; GPS is stripped.
- The app builds and tests pass with every optional module disabled.
- Contrast, keyboard navigation and focus order pass automated accessibility checks.

Wire these into a single `npm run verify` that CI runs on every push and that must be
green before anything merges.

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

1. Anything contradictory, under-specified, or over-engineered for the stated scale —
   including anything in the source document that you think will not survive contact with
   how the practice actually works.
2. Your module boundaries and the Phase 0 schema.
3. The journey definition as data: phases, gates, and how a phase advance is evaluated.
4. The security model: RLS policy shape, principal types, session design, the
   authorisation surface, and specifically how the internal/client wall is enforced in
   the database rather than in application code.
5. The token architecture and how a supplied brand is injected.
6. The Phase 0 build order, and what you need from me at each step.
