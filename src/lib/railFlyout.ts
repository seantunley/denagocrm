/**
 * The collapsed sidebar's group flyout — when it is open, and HOW it was opened
 * (review of #1081). Hover and click used to fight: hovering opened it, then the
 * click that followed toggled it shut; and an opening by hover moved keyboard
 * focus into it, away from wherever the person was.
 *
 * One rule set, pure, so both sequences are tested:
 *  - hovering opens it ("hover"); leaving closes only a hover-opened flyout;
 *  - a click (or Enter/Space, which click a button) on an icon that hover
 *    opened KEEPS it open and makes it a click-opened one; a click on a closed
 *    icon opens it; a click on a click-opened one closes it;
 *  - Escape or clicking away closes it, however it opened;
 *  - only a click/keyboard opening takes focus into the flyout — hovering never does.
 */
export type FlyoutState = { open: false } | { open: true; via: "hover" | "click" };
export type FlyoutEvent = "pointer-enter" | "pointer-leave" | "click" | "dismiss";

export const FLYOUT_CLOSED: FlyoutState = { open: false };

export function railFlyout(state: FlyoutState, event: FlyoutEvent): FlyoutState {
  switch (event) {
    case "pointer-enter":
      return state.open ? state : { open: true, via: "hover" };
    case "pointer-leave":
      return state.open && state.via === "hover" ? FLYOUT_CLOSED : state;
    case "click":
      if (!state.open) return { open: true, via: "click" };
      return state.via === "hover" ? { open: true, via: "click" } : FLYOUT_CLOSED;
    case "dismiss":
      return FLYOUT_CLOSED;
  }
}

/** Whether this flyout should hold keyboard focus: only when a click or a key opened it. */
export function flyoutTakesFocus(state: FlyoutState): boolean {
  return state.open && state.via === "click";
}
