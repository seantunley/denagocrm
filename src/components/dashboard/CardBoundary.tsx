"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * ONE BAD CARD COSTS EXACTLY ONE CARD — kept true once cards stream.
 *
 * `renderCard` already turns a failed card into an inline notice, and
 * DashboardView catches anything that gets past it. Both of those work because
 * the card is AWAITED on the server: the error happens while the page is being
 * assembled, where there is something to catch it.
 *
 * A streamed card is different. Its work continues after the shell has been
 * sent, so a throw no longer lands in that try/catch — it goes to the nearest
 * React error boundary instead. Without one per card, that is the page boundary,
 * and streaming would have quietly traded the dashboard's strongest guarantee
 * for a faster first paint: one bad card taking down the whole screen, which is
 * the failure this codebase has spent the most effort avoiding.
 *
 * So every streamed card gets its own boundary. It is a class component because
 * that is still the only way to catch a render error in React.
 *
 * WHAT IT SHOWS. The same "could not be loaded" language as the server-side
 * fallback, and deliberately no detail: a card that failed on a row the viewer
 * should never have seen must not describe that row on its way out. The error is
 * reported to the server by the page-level boundary's reporter only if it
 * escalates — here it is logged to the console and contained.
 */
type Props = { title?: string; children: ReactNode };
type State = { failed: boolean };

export class CardBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Contained, but not silent. Without this a card can fail on every render
    // and leave nothing anywhere to say which one.
    console.error("[dashboard-card] failed to render", this.props.title ?? "(untitled)", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full min-h-24 flex-col justify-center rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0 text-amber-400" aria-hidden />
          <span>
            {this.props.title ? `“${this.props.title}” ` : "This card "}
            could not be loaded.
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/80">
          The rest of the dashboard is unaffected.
        </p>
      </div>
    );
  }
}
