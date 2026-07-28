# Per-tenant branding — roadmap

Status: **planned, not started.** Written 28 Jul 2026 after scoping against the
codebase. Picks up after the platform console (#226) lands.

Goal: a platform admin sets a tenant's **accent colour and logo** in the console,
and that branding applies across the CRM, customer-facing pages, emails and
printed documents.

---

## Decisions already made

| Question | Decision |
|---|---|
| Surfaces | CRM app UI, customer-facing pages, emails, PDFs/print — all four |
| Depth | **Accent colour + logo only.** Not a curated palette, not custom CSS |
| Who sets it | **Platform admin only**, in the console. Tenants do not self-serve |
| Logo delivery | **Upload to blob storage**, reusing the existing pipeline |

Depth matters most: one accent colour cannot produce an unreadable UI, needs no
design review per tenant, and covers what tenants generally mean by "our
branding". Custom CSS was rejected as an XSS and support burden; a curated palette
was rejected because arbitrary combinations need contrast validation and previews.

---

## What the codebase already gives us

Scoped by reading the code, not assumed:

- **The app is fully tokenised.** `src/app/globals.css` defines ~75 CSS custom
  properties on `:root`, mapped into Tailwind via `@theme inline`. Components
  consume tokens, not literal colours. Overriding `--primary` therefore re-themes
  the app without touching components. **This is why colour is cheap.**
- **One theme.** `color-scheme: dark` only — no light/dark pair to brand twice.
- **Blob storage exists.** `src/lib/storage.ts` (`putManagedBlob`, `deleteFile`)
  is already used by backups and documents; logo upload reuses it.
- **Tenant scope on public surfaces exists.** `establishTenantScopeFromId` and
  `withTokenTenantScope` (`src/lib/tenantScopeEntry.ts`) already resolve the owning
  tenant for portal and token pages, so those surfaces can discover which brand to
  render.

## What makes it more than a day

- **Colours are `oklch(...)`.** A colour picker yields hex. Either convert on
  save, or store hex and emit it directly (CSS accepts both) — but the two must
  not be mixed carelessly when computing contrast.
- **16 files hardcode the Denago logo.** Mechanical, but real:

  ```
  src/app/(app)/settings/documents/t/[id]/page.tsx
  src/app/(print)/jobcards/[id]/print/page.tsx
  src/app/login/page.tsx
  src/app/messages/layout.tsx
  src/app/portal/layout.tsx
  src/app/portal/login/page.tsx
  src/app/s/layout.tsx
  src/components/AppShell.tsx
  src/components/KanbanBoard.tsx
  src/components/doceditor/BlockView.tsx
  src/components/print/PrintDocShell.tsx
  src/components/print/QuotePrintDoc.tsx
  src/lib/campaigns.ts
  src/lib/customDocs.ts
  src/lib/signature.ts
  src/lib/signedPdf.ts
  ```

  Re-check with `grep -rlo "branding/denago" src`.
- **Email cannot use CSS variables.** Most mail clients ignore custom properties,
  so email templates need inline styles and an absolute logo URL. This is a
  separate templating job, not a token override.
- **Print deliberately forces light.** `globals.css:134` — *"Printing must always
  be on white paper, never the app's dark theme."* Brand colour must be applied to
  print without harming legibility on paper.
- **`/login` is pre-tenant.** The CRM sign-in page cannot know the tenant before
  authentication. Either keep it neutral, or resolve brand by hostname if
  per-tenant domains ever land. **Keep it neutral for now.**

---

## Phases

Phases 1–2 are the cheap ~80% and ship independently. Do them first and look at
the result before committing to 3–5.

### Phase 1 — schema, upload, console UI

- `Tenant.brandPrimary String?` (hex, e.g. `#ea580c`) and `Tenant.logoRef String?`
  (blob path). Null on both = current Denago default, so **nothing changes for
  existing tenants until someone sets it**.
- Logo upload in the console: validate MIME and size, write via `putManagedBlob`,
  store the ref. Delete the old blob on replace.
- Reject anything that is not a plain hex colour. The value is interpolated into a
  stylesheet, so treat it as untrusted input — a colour field is a CSS injection
  vector otherwise.
- Audit brand changes like any other tenant mutation.

### Phase 2 — CRM app UI

- Resolve the acting tenant's brand in the `(app)` layout and inject a scoped
  override:

  ```html
  <style>:root{--primary:#ea580c;--primary-foreground:#fff}</style>
  ```

- Compute `--primary-foreground` automatically from the accent's luminance rather
  than storing it. One colour in, readable text guaranteed.
- Replace the hardcoded logo references above with a tenant-aware component that
  falls back to the Denago asset when `logoRef` is null.
- **Cache the lookup per request.** It is read on every page render; wrap in
  `cache()` as `getEnabledModuleIds` does.

### Phase 3 — customer-facing pages

Portal, signing, survey and approval pages. Each already resolves a tenant scope;
the work is rendering brand from it and removing the Denago assumption. These are
what a tenant's **customers** see, so arguably higher value than internal chrome.

Note these are `PUBLIC_PATHS` in `src/proxy.ts` with no staff session, so brand
must be read with `basePrisma` from the token/contact-derived tenant.

### Phase 4 — emails

Inline styles, absolute logo URLs, per-tenant sender identity. Touches
`src/lib/email.ts`, `src/lib/campaigns.ts` and the template rendering.

### Phase 5 — PDFs and print

`PrintDocShell`, `QuotePrintDoc`, job cards, signed PDFs, Document Studio. Apply
accent within the light print theme without hurting contrast on paper.

---

## Explicitly out of scope

- **PWA manifest and icons** (`/manifest.webmanifest`, `/icons`). These are
  per-install, not per-request, so per-tenant PWA branding needs per-tenant
  domains or dynamic manifests — a much larger change. Revisit only if tenants get
  their own hostnames.
- **Custom fonts.** Adds loading, licensing and layout-shift concerns for little
  gain at this depth.
- **Tenant self-service.** Decided: platform admin only.

## Open questions

- Do tenants ever get their own **hostname**? That answer changes the login page,
  the PWA question and email sender domains. Worth settling before phase 4.
- Should brand changes be **versioned/reversible**? An audit row records what
  changed, but there is no "revert to previous brand" today.
- Do **existing** printed/signed PDFs need to keep the branding they were issued
  with? A signed document that silently re-brands on re-render is arguably a
  records-integrity problem.

## Rough effort

| Phase | Size |
|---|---|
| 1 — schema, upload, console | small |
| 2 — CRM app UI | small–medium (the 16 logo sites dominate) |
| 3 — customer-facing | medium |
| 4 — emails | medium |
| 5 — PDFs/print | medium |

All five together: about a week of focused work. Phases 1–2 alone: a couple of
days, and they are what most people mean when they ask for tenant branding.
