/**
 * When navigation dismisses a dialog, and when it may show again. Pure, so the
 * sequence rules are testable without a DOM (tests/dialogNavigation.test.ts).
 *
 * - A dialog belongs to the pathname it opened on.
 * - Leaving that pathname DISMISSES it, and the dismissal is sticky: coming back
 *   to the original pathname must NOT bring it back while the owner's `open` is
 *   still true (a dialog living across routes, e.g. AppShell's QuickCreateDialog,
 *   would otherwise reopen by itself — review finding on #688).
 * - Only a real reopen (owner's open false → true) clears the dismissal.
 */
export type DialogNavState = { wasOpen: boolean; openedOn: string | null; dismissed: boolean };

export function initialDialogNavState(open: boolean, pathname: string): DialogNavState {
  return { wasOpen: open, openedOn: open ? pathname : null, dismissed: false };
}

/** The next state for this render's (open, pathname). Returns the same object when nothing changed. */
export function nextDialogNavState(state: DialogNavState, open: boolean, pathname: string): DialogNavState {
  if (open !== state.wasOpen) return { wasOpen: open, openedOn: open ? pathname : null, dismissed: false };
  if (open && !state.dismissed && state.openedOn !== null && pathname !== state.openedOn) {
    return { ...state, dismissed: true };
  }
  return state;
}

export function dialogVisible(state: DialogNavState, open: boolean): boolean {
  return open && !state.dismissed;
}
