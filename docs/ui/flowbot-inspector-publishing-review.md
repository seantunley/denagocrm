# Flowbot inspector and publishing UX review

Manual review checklist for the stacked UI publishing PR.

- [ ] 390px: readiness card remains readable and actions wrap without overflow.
- [ ] 768px: flow cards retain hierarchy and publish dialog fits the viewport.
- [ ] 1440px: readiness detail is scannable without making cards excessively tall.
- [ ] Publish dialog clearly names channel, affected routes, warnings, draft node count and live version/node count.
- [ ] Cancel leaves the saved draft unchanged.
- [ ] A successful publish closes the dialog, shows the returned immutable version and refreshes the library.
- [ ] A compiler refusal keeps the dialog open and shows the server error.
- [ ] A concurrent draft change is refused; no version is published.
- [ ] Existing in-progress conversations remain pinned to their starting version.
- [ ] Keyboard-only: open publish review, inspect content, cancel and publish controls are reachable.
- [ ] Light/dark themes: warning, success, error and neutral states retain readable contrast.
