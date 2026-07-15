# Visual consistency guardrails

The refreshed Denago CRM interface now has explicit patterns for page hierarchy, entity details, responsive lists, feedback, loading states, and builder workspaces. New screens should extend those patterns instead of recreating them locally.

## Required patterns

- Use `PageHeader` for standard route headings and `EntityDetailShell` for entity records.
- Use `ResponsiveDataView` when mobile and desktop need different representations.
- Use `ResponsiveEntityTable` for ordinary record tables that should become labelled cards on phones.
- Keep horizontal scrolling for real comparisons, timelines, audit histories, calendars, and dense line-item editing.
- Use `StatusPill`, `EmptyState`, `PageSkeleton`, the toast system, and designed confirmation dialogs for shared feedback.
- Keep builder chrome dark and use the white surface only for the authored document or canvas.
- Preserve visible keyboard focus and reduced-motion behaviour.

## Automated check

Run:

```bash
npm run check:visual
```

The check blocks new native browser dialogs, unapproved raw route headings, and ordinary horizontally scrolling tables that do not opt into an intentional responsive pattern. Existing specialist exceptions are named in the script so that additions are deliberate and reviewable.

The same check runs automatically on pull requests that change application or component UI.

## Review checklist

1. Check the route at phone, tablet, and desktop widths.
2. Confirm dialogs fit the viewport and keep their primary action reachable.
3. Navigate the page with the keyboard and verify focus remains visible.
4. Check loading, empty, error, success, destructive, and permission-limited states.
5. Use semantic status tokens and Lucide icons rather than arbitrary colours or emoji actions.
6. Confirm ordinary data lists do not require horizontal scrolling on a phone.
