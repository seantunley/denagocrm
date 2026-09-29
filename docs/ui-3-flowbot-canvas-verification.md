# UI-3 Flowbot canvas verification

PR scope is UX-only and must preserve the existing Flowbot runtime, compiler, autosave concurrency fence, tenant scoping and publication semantics.

## Review checklist

- [ ] Node palette search filters existing supported nodes only.
- [ ] Palette categories remain Messages, Customer input, Logic & data, AI & operations.
- [ ] Click-to-add still works.
- [ ] Drag a node from the palette onto the canvas and confirm it lands at the pointer and snaps to the 20px grid.
- [ ] Mini-map pans/zooms and fit/zoom controls remain usable.
- [ ] Condition Yes/No, AI handoff, action failure and unavailable routes remain visually distinct.
- [ ] Selecting a node emphasises only its incoming/outgoing route and de-emphasises unrelated edges.
- [ ] Duplicate creates an independent node offset from the source and never makes it the start node automatically.
- [ ] Set start continues to update only the existing draft graph.
- [ ] Empty canvas presents onboarding and opens the palette.
- [ ] Existing undo/redo, autosave, browser recovery and conflict handling still work.
- [ ] Existing live validation still focuses the affected node.
- [ ] Simulator toggle still runs the current in-memory draft.
- [ ] 390px: no horizontal page overflow; palette/inspector use bottom sheets.
- [ ] 768px: canvas remains usable with palette/inspector sheets.
- [ ] 1440px: palette, canvas and inspector can coexist without clipping.
- [ ] Keyboard-only toolbar and inspector walkthrough.
- [ ] Dark theme visual inspection; light theme where the enclosing app supports it.
- [ ] No console errors on the Vercel preview.

## Explicit non-goals

No flow execution changes, provider/webhook changes, schema/migration changes, tenant ownership changes, analytics calculation changes, AI prompt/retrieval changes or version-pinning/publication changes.
