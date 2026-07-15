# Visual consistency sweep

Date: 15 July 2026
Baseline: the responsive contact, lead, job-card, stock, vehicle and part capture workspaces.

## Standard established

New and refreshed CRM surfaces should use the same product language:

- `PageHeader` for route identity, description and actions.
- `CaptureHero`, `CaptureSection`, `CaptureField` and `CaptureFooter` for structured create/edit flows.
- `Surface` and `SectionHeading` for secondary workspace panels.
- `MetricCard` inside `KpiGrid` for operational summaries.
- `StatusPill` and `FeedbackBanner` for semantic state and feedback.
- `EmptyState` for a useful next step rather than a muted sentence.
- `ResponsiveDataView` with `MobileDataList` for ordinary entity lists; horizontal tables remain appropriate for calendars, comparisons, audit detail and builders.
- Lucide icons rather than emoji or text glyphs for product actions.

The visual hierarchy is: route header, optional KPI or context strip, primary working surface, then supporting detail. Important capture flows use grouped sections and a sticky mobile action rather than one long undifferentiated card.

## Changes included in this PR

| Area | Consistency change |
| --- | --- |
| Product catalogue | Rebuilt product creation as the same responsive capture workspace used by stock, vehicles and parts. Added a live model, price and colour summary. |
| Product list | Added a deliberate mobile record list, semantic statuses and an actionable empty state. |
| Referrals | Added operational KPI cards, semantic reward states and a mobile redemption flow. |
| Customer health | Replaced generic statistic cards and emoji headings with semantic metrics, icons and responsive customer lists. |
| Trash | Added the standard route header, recovery empty state, semantic purge urgency and mobile restore cards. |
| Document library | Standardised the route header and empty state and replaced emoji/text-glyph actions with product icons. |
| Duplicate contacts | Added the standard route header and a useful clean-state treatment without celebratory emoji. |
| Forecast and audit | Aligned route headers; forecast totals now use the shared metric system. |
| Marketing journeys | Aligned the route header, warning, empty states and run/journey statuses with shared feedback primitives. |
| Mobile dialogs | Raised and restyled the shared close control so sticky dialog headers can no longer cover it. |

Measured before this pass, the staff application had 77 route pages, 43 files with hand-built `h1` headers, 29 files rendering tables, only one route using an explicit responsive data-list pattern, 39 files with sentence-only empty states, nine route loading files, and nine native `alert`, `confirm` or `prompt` calls. This PR moves nine route surfaces onto the standard header and increases explicit responsive-list adoption from one route to five. The remaining counts identify migration work; not every detail page or dense table should be mechanically converted.

## Recommended next builds

### 1. Settings workspace system

This is the largest visible gap. The main settings route is a very long collection of bespoke cards and manually coloured connection badges, while subpages use several different header scales and layouts.

Build:

- a searchable settings landing page grouped by Business, Communications, Documents, Security and Data;
- shared `SettingsPageHeader`, `SettingsSection` and `IntegrationCard` patterns;
- one semantic connected, attention, unavailable and disabled status system;
- a mobile settings index instead of long in-page navigation;
- consistent save feedback and a persistent unsaved-changes state.

### 2. Entity detail shell

Contact, lead, vehicle, quote, job-card, campaign and case detail screens each assemble identity, status and actions differently.

Build:

- a shared entity hero with breadcrumb, primary identity, status, owner and key facts;
- a predictable action rail with one primary action and overflow for secondary actions;
- a consistent timeline/document/activity tab treatment;
- compact mobile summary and sticky primary action;
- shared not-found, restricted and archived states.

### 3. Mobile entity-list migration

Ordinary CRM records should not depend on a horizontally scrolling desktop table. The remaining high-value conversions are contacts, quotes, job cards, service due, cases, campaigns, fleets and signatures. Audit history and forecast comparisons may retain a dense table, but need an intentional mobile summary or drill-in mode.

Build `MobileDataList` variants for:

- person/account records;
- financial records with totals and status;
- task/workshop records with due state and owner;
- governance events with expandable context.

### 4. Feedback and loading coverage

Only nine staff route groups currently define a route-level loading experience, and many modules still render an isolated muted sentence for empty data. The document editor also retains native browser dialogs.

Build:

- list, detail, settings, report and builder skeleton families;
- route-level `loading.tsx` coverage for the high-traffic modules;
- designed prompt/confirmation workflows in Document Studio and Signatures;
- shared inline validation and background-operation feedback;
- actionable empty states for campaigns, automations, communications, documents and builders.

### 5. Builder workspace shell

Document Studio, Flow Builder, Journey Builder, Survey Builder and bot flows are legitimate full-workspace exceptions, but their surrounding chrome and save/publish language should still match.

Build:

- one dark builder shell around each specialised canvas;
- consistent save state, undo/history, preview, publish and exit actions;
- collapsible desktop palette/inspector panels and mobile drawers;
- semantic Lucide node/tool icons and a controlled node palette;
- full-screen mobile modes where canvas interaction is the primary task.

### 6. Visual quality guardrails

After the component migrations, add lightweight enforcement so the UI does not drift again:

- Storybook or a protected internal pattern-library route for the approved states;
- screenshot checks at desktop and 390 px for the shared primitives;
- lint guidance for new raw route `h1` elements, native dialogs and emoji actions;
- an accessibility pass covering focus order, labels, reduced motion and muted-text contrast.

## Suggested delivery order

1. Settings workspace system.
2. Entity detail shell for contact and lead, then quote and job card.
3. Mobile lists for the highest-traffic operational routes.
4. Feedback, loading and empty-state coverage.
5. Unified builder shell.
6. Visual regression and accessibility guardrails.

This order improves the most frequently encountered product chrome first, then addresses specialised workspaces after the shared system is stable.
