# Build prompt — Architect practice platform

Paste everything below the line into a fresh Claude Code session opened on an **empty
repository**. It is written to be executed, not admired: it ends with a definition of
done that can be checked mechanically.

Fill in the four bracketed values at the top before you send it.

---

You are building the software platform for a high-end architectural practice. Read this
entire brief before writing a single file. When you are ready, produce a plan first and
wait for approval — do not start scaffolding on the strength of this message alone.

## 0. The variables

- **Practice name:** `[FIRM NAME]`
- **Primary jurisdiction / data residency:** `[e.g. South Africa — POPIA; or EU — GDPR]`
- **Expected scale year one:** `[e.g. 12 staff, 40 active projects, 300 client users]`
- **Deployment target:** `[e.g. Vercel + Neon; or AWS eu-west-1]`

If any of these are still blank, ask for them before planning. Everything else in this
brief is decided.

## 1. What this is

One platform holding **everything that passes between the practice and its clients**:

- **Projects** — the spine. Every other object hangs off a project.
- **Milestones and programme** — stages of work with dates, dependencies, status,
  and a client-legible view of "where we are".
- **Documents** — drawings, reports, certificates, correspondence. Versioned, issued,
  and access-controlled.
- **Updates** — the practice publishes progress; clients read it and respond.
- **Communications** — the full record of what was said, by whom, when, against which
  project. Email in and out at minimum.
- **The client portal** — the product's face. A client logs in and understands the
  state of their building in under ten seconds, without a phone call.

This is not a generic CRM with an architecture skin. The unit of work is the *project*,
the audience is *two distinct populations* (practice staff and clients), and the
material is *drawings and decisions*.

## 2. The three constraints that outrank everything

Every design decision is settled by these, in this order.

### 2.1 Secure by construction, not by review

A client of this practice can see their project and **nothing else, ever**, and that
must be true even when a route handler is written carelessly. Security lives in layers
that do not depend on the caller remembering:

1. **Postgres row-level security** as the last line of defence. The application
   connects as a role that has RLS enforced (`NOLOGIN BYPASSRLS` is not that role);
   every tenant- and project-scoped table carries a policy keyed off session GUCs set
   at connection checkout. A query that forgets its `WHERE` clause returns nothing, not
   everything. Write the test that proves this before you write the second feature.
2. **A scoped data accessor.** No route or server action touches the raw database
   client. They receive a request-scoped context carrying the authenticated principal,
   and all reads/writes go through accessors that cannot be constructed without it.
   Make the unscoped client physically hard to reach — a lint rule that fails the build
   on direct import outside the data layer.
3. **Deny-by-default authorisation.** A central policy layer answers `can(principal,
   action, resource)`. New resources are inaccessible until a policy is written for
   them. Never the inverse.
4. **Two separate identity domains.** Staff and client portal users are different
   principal types, with different session cookies, different names, different
   lifetimes, and no code path that can promote one into the other. The portal is the
   internet-facing attack surface: treat every byte it accepts as hostile. Client
   sessions get shorter expiry, stricter re-auth on sensitive actions, and their own
   rate limits.
5. **Append-only audit.** Who saw which document, who approved what, who changed a
   date. Writes only; no update or delete path exists in the application at all. For a
   practice carrying professional indemnity, this is a product feature, not plumbing.

Beyond the layers: argon2id or scrypt password hashing, sessions as opaque server-side
records (not self-describing tokens), CSRF protection on every mutation, a real
Content-Security-Policy with no `unsafe-inline`, strict security headers, per-route
rate limiting, secrets never in the repo (add secret scanning to CI on day one),
structured logs that carry ids and never PII or file contents, and dependency updates
on a schedule.

Uploads deserve their own paragraph. Files are the highest-risk input this system takes:
store them in **private** object storage — never a public bucket, not once, not for
"just the thumbnails"; serve them only through short-lived signed URLs minted after an
authorisation check; validate content by sniffing bytes rather than trusting the
extension or `Content-Type`; store a checksum; strip or quarantine anything active
(SVG, HTML, PDF with embedded JS); and leave a documented seam for malware scanning
even if the scanner itself comes later.

### 2.2 Modular

The build is modular, and the modularity has to be structural or it will not survive
contact with a deadline.

- **A kernel that knows nothing about modules.** Identity, sessions, authorisation
  primitives, tenancy, audit, storage, notifications, jobs, the design system. The
  kernel never imports from a module.
- **Modules are self-contained slices**, each owning its schema, its policies, its
  routes, its UI, its migrations, its tests, and declaring what it exposes:

  ```
  modules/
    projects/     manifest.ts  schema.prisma  policy.ts  server/  ui/  tests/
    documents/
    milestones/
    updates/
    comms/
    portal/
  ```

- **A module manifest** declaring id, human name, dependencies on other modules, the
  navigation and portal surfaces it contributes, the policy actions it defines, and its
  migrations. Composition happens through the registry; modules never import each
  other's internals, only their published contracts.
- **Modules are switchable per deployment.** Disabling one removes its routes, its
  navigation, its jobs and its portal surfaces, and leaves an app that still builds,
  still passes tests, and never renders a dead link. Enforce it with a test that boots
  the app with an empty module set.
- **Enforce the boundaries in CI.** A dependency-direction lint rule (kernel ↛ module,
  module ↛ module internals) that fails the build. Written conventions decay; a failing
  check does not.

Build these four extension points into the kernel now, with one real consumer each, and
leave them unimplemented beyond that. They are what the practice will ask for next, and
retrofitting any of them is a rewrite:

| Seam | Why it must exist on day one |
| --- | --- |
| **Approvals** | A client signing off a stage, a revision, or a variation. Needs an approvable-object interface, an immutable decision record, and a signature adapter. |
| **Annotation** | Comments anchored to a coordinate on a document page or image, revision-aware. Needs documents to expose stable page/region addressing from the start. |
| **Structured decisions** | Finishes, fixtures, specification choices — an option set, a selection, a lock date, a cost. |
| **Money** | Fee stages, invoices against milestones, payment state. Milestones must be able to carry a monetary obligation without a schema migration. |

Do not build these features. Build the joints they will attach to, ship one thin real
use of each seam so it is proven rather than theoretical, and document the intended
shape in `docs/seams.md`.

Similarly, **file handling is an adapter, not a hardcoding.** The practice's actual
formats are not yet confirmed and may include PDF drawing sets, CAD and BIM files
(DWG, RVT, IFC), high-resolution renders and site photography, or files that live in
Dropbox / SharePoint / Google Drive today. So: a `StorageAdapter` interface (local disk
for dev, object storage for production, external-provider sync later) and a
`PreviewAdapter` interface (`canPreview(mime) → renderer`) with PDF and image
implemented now, everything else registering later without touching the document model.
Documents store bytes, checksums, MIME and revision lineage — never format-specific
assumptions.

### 2.3 Visually exceptional

Clients of a high-end practice judge the platform the way they judge a building. The
interface has to be the calibre of the work it displays.

The brand identity will be supplied by the practice and is **not yet available**, so:

- **Every visual value is a token.** Colour, type scale, spacing, radii, shadow,
  motion. A hex code, a font name or a magic pixel value anywhere in a component is a
  defect. Add a check that greps for them and fails.
- **Brand is configuration, injected at runtime** — palette, typefaces, logo, wordmark,
  radius and density — resolved once and exposed as CSS custom properties. Swapping the
  brand must be one config change, not a find-and-replace. Validate the palette on the
  way in (it lands in a stylesheet: it is untrusted input) and *derive* readable
  foreground colours from luminance rather than storing them, so no supplied brand can
  produce unreadable text.
- **The default brand is a finished, restrained neutral** — near-black ink, warm paper
  white, one accent, a fine serif for display and a precise grotesque for interface —
  that looks deliberate the day it ships and vanishes the day the real identity
  arrives.
- **Sharp means sharp.** Renders and drawings are the content, so: an image pipeline
  producing AVIF and WebP at device-pixel-ratio-aware widths, never upscaling, blur or
  dominant-colour placeholders, colour profile preserved on renders, lazy loading below
  the fold and priority loading for the hero. A soft render on a Retina display fails
  the brief exactly as badly as a broken link.
- **Typography and space carry the design**, not chrome. A modular type scale, a real
  baseline rhythm, generous margins, hairline rules. Restraint reads as expensive;
  gradients and drop shadows read as a template.
- **Motion is functional and fast** — 150–250ms, entrances and state changes only,
  fully honouring `prefers-reduced-motion`.
- **Two surfaces, one system.** Staff get a dense, keyboard-driven working environment.
  Clients get a calm, spacious, near-editorial reading experience. Same tokens, same
  components, different density and rhythm — controlled by a density token, not a
  forked component library.
- **WCAG 2.2 AA is a floor, verified in CI** — contrast, focus visibility, keyboard
  paths, semantics, a genuinely usable portal on a phone. Test it with automation *and*
  a keyboard.

## 3. Stack

Start from this and justify any deviation in `docs/adr/0001-stack.md`:

- **Next.js (latest stable) with the App Router, TypeScript in strict mode**
- **PostgreSQL** — non-negotiable; RLS is the security model
- **Prisma** for schema and migrations, with raw SQL migrations for policies and
  anything Prisma cannot express
- **Tailwind CSS v4**, driven entirely by the token layer, with a small owned component
  set — no wholesale UI framework adoption that fights the brand later
- **Zod** at every trust boundary: request bodies, form data, environment, webhook
  payloads, and external API responses
- **Argon2id** for passwords; server-side opaque sessions
- **A real background job runner** with retries and idempotency — email, image
  derivatives, scans and notifications never run inline in a request

**Read the installed documentation before you write code against any of these.**
Framework majors move faster than model training data; `node_modules/<pkg>/` and the
official docs for the *installed* version are the source of truth, and a confidently
wrong API from memory costs more than the five minutes of reading. When the installed
version disagrees with what you remember, the installed version is right.

## 4. Domain model — get these right, the rest follows

**Workspace scoping from day one.** Even though this launches for one practice, every
table carries a workspace/tenant id and every policy keys off it. It costs almost
nothing now; it is close to impossible to retrofit, and it is what makes a second
practice — or a hard separation between the practice and a subsidiary — a configuration
change rather than a rebuild. (Say so in an ADR; if you disagree, argue it there before
building.)

Core entities:

- **Project** — code, name, client(s), address, stage, status, team, dates, cover
  image. The scoping root for everything below.
- **ProjectMember** — a person's relationship to a project, and the *only* thing that
  grants a client any visibility. Access is granted per project, never globally.
- **Milestone** — a programme item: title, stage, planned/actual dates, dependencies,
  status, visibility to client, and a nullable monetary obligation (see the money seam).
- **Document** and **DocumentRevision** — the document is the identity, the revision is
  the file. Revisions are immutable, numbered, checksummed, and carry an *issue* record:
  who issued it, to whom, when, and under what purpose. Superseding never destroys.
- **Update** — a published post against a project: title, rich body, attachments,
  publish state, audience. Drafts are never visible to clients.
- **Communication** — a message in the record: direction, channel, participants,
  content, project link, timestamps.
- **Approval** *(seam)* — a decision record against any approvable object: who, what,
  which revision, when, and the evidence.
- **AuditEvent** — actor, action, resource, metadata, timestamp. Append-only.
- **Principal** — split cleanly into `StaffUser` and `ClientUser`, sharing nothing but
  a contact record.

Model the **visibility of every client-facing object explicitly**. Never infer "the
client can see it" from the absence of a flag; a new column must default to hidden. The
worst possible failure of this product is a client seeing an internal note, a draft
drawing, or another client's project.

## 5. What to build first

**Phase 0 — the walking skeleton.** One vertical slice, fully hardened, end to end:

1. Repository, CI, environment validation, secret scanning, formatting, strict lint.
2. Kernel: database with RLS enabled and proven, scoped accessor, policy layer, staff
   auth, client auth, audit, storage adapter, job runner, design tokens, base
   components.
3. Module registry, manifests, boundary lint, and the empty-module-set boot test.
4. `projects` module: create a project, add staff and a client member, view it.
5. `milestones` module: a programme on a project, staff-editable, client-visible.
6. `documents` module: upload → revision → issue → client downloads it through a
   signed URL, with every step audited.
7. `updates` module: draft, publish, client reads it.
8. `portal`: login, project overview, programme, documents, updates. Beautiful. Not a
   placeholder — this screen is the product demo.

**Phase 0 is not done until a hostile test suite passes**, and these tests are written
alongside the features, not after:

- A client user cannot read another project's data — through the API, through a server
  action, through an id in a URL, through a signed URL that was minted for someone else.
- A query run without tenant context returns zero rows (RLS proven, not assumed).
- A draft update and an unissued revision are invisible to clients.
- A staff session cookie cannot authenticate against portal routes, and the reverse.
- Signed URLs expire, and are bound to the principal they were issued to.
- Every mutating route rejects a request without CSRF protection.
- The app builds and its tests pass with every optional module disabled.
- Contrast, keyboard navigation and focus order pass automated accessibility checks.

Wire these into a single `npm run verify` that CI runs on every push and that must be
green before anything merges.

**Deliberately not in phase 0:** approvals, markup, selections, invoicing, CAD/BIM
preview, mobile apps, AI features, third-party sync. Their seams exist; their features
wait.

## 6. How to work

- **Plan before building.** Produce the phase 0 plan, the module list, the schema, and
  the security model as documents. Get them approved. Then build.
- **Small, coherent, reviewable commits** with messages that explain *why*.
- **Write down decisions.** `docs/adr/` for anything a future maintainer would
  otherwise have to reverse-engineer. Comments explain the reasoning that the code
  cannot.
- **Every security control needs a test that fails when the control is removed.** An
  untested control is a comment.
- **Never weaken a check to make something pass.** Not the type checker, not the lint
  rule, not the CSP, not a test. If a control is wrong, argue it and change it
  deliberately, in its own commit.
- **A fix for a defect found in review targets the main branch**, not the branch that
  introduced it — a stacked fix is only safe while its base is unmerged, and nothing
  watches for that changing. After any merge, verify the change actually reached the
  branch that deploys.
- **Ask when the answer changes the architecture.** Proceed with a stated assumption
  when it does not.

## 7. Your first response

Do not write code yet. Reply with:

1. Anything in this brief that is contradictory, under-specified, or that you would
   push back on — including anything you think is over-engineered for the stated scale.
2. Your proposed module boundaries and the schema for phase 0.
3. The security model: RLS policy shape, principal types, session design, and the
   authorisation surface.
4. The token architecture and how a supplied brand is injected.
5. The phase 0 build order, and what you will need from me at each step.
