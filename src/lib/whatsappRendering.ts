/**
 * What WhatsApp will ACTUALLY show, given what the flow engine emitted.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * The limits below were written out as bare `.slice(0, 20)` calls inside the
 * send functions in `whatsapp.ts`. That is fine for sending and useless for
 * previewing: the builder's simulator rendered every option as a plain list,
 * untruncated, so a flow could look correct in testing and arrive on a phone
 * with its labels cut mid-word — or with option four onwards moved behind a
 * "Choose" menu the author never saw.
 *
 * So the numbers live here, once, and `whatsapp.ts` imports them. A preview that
 * disagreed with the transport would be worse than no preview, because it would
 * be believed.
 *
 * These are Meta's Cloud API limits for interactive messages, not our policy —
 * we cannot raise them, only decide what to do when a flow exceeds them.
 *
 * ── THE BUTTONS/LIST SWITCH IS THE SUBTLE ONE ───────────────────────────────
 *
 * `botOutbox.ts` picks the shape by option count: three or fewer become tappable
 * reply BUTTONS, four or more become a LIST behind a menu button. Same authored
 * node, materially different experience — and different title limits, 20 against
 * 24. Adding a fourth option silently changes the interface. The preview exists
 * mostly to make that visible.
 */

/** Body text on any interactive message. */
export const WA_BODY_MAX = 1024;
/** Reply buttons: at most three, titles cut hard at twenty characters. */
export const WA_BUTTON_MAX = 3;
export const WA_BUTTON_TITLE_MAX = 20;
/** List rows: at most ten, titles at twenty-four, descriptions at seventy-two. */
export const WA_LIST_ROW_MAX = 10;
export const WA_LIST_TITLE_MAX = 24;
export const WA_LIST_DESCRIPTION_MAX = 72;
/** The label on the button that opens the list sheet. */
export const WA_LIST_BUTTON_MAX = 20;

export type ChoiceOption = { id: string; label: string; description?: string };

export type RenderedOption = {
  id: string;
  /** Exactly the characters WhatsApp will display. */
  title: string;
  description?: string;
  /** True when the author's text did not fit and was cut. */
  titleTruncated: boolean;
  descriptionTruncated: boolean;
};

export type RenderedChoice = {
  /** Which interface WhatsApp will draw — decided by option count alone. */
  shape: "buttons" | "list";
  body: string;
  bodyTruncated: boolean;
  options: RenderedOption[];
  /** Options beyond the limit, which the recipient never sees at all. */
  dropped: ChoiceOption[];
};

function cut(value: string, max: number): { text: string; truncated: boolean } {
  return value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false };
}

/**
 * Render a `choice` message the way the transport will.
 *
 * Mirrors `botOutbox.ts` exactly: `options.length <= 3` chooses buttons. The
 * threshold is duplicated nowhere — it is expressed here as WA_BUTTON_MAX, which
 * is the same number for the same reason.
 */
export function renderWhatsAppChoice(body: string, options: ChoiceOption[]): RenderedChoice {
  const shape = options.length <= WA_BUTTON_MAX ? "buttons" : "list";
  const limit = shape === "buttons" ? WA_BUTTON_MAX : WA_LIST_ROW_MAX;
  const titleMax = shape === "buttons" ? WA_BUTTON_TITLE_MAX : WA_LIST_TITLE_MAX;
  const shown = options.slice(0, limit);
  const bodyCut = cut(body, WA_BODY_MAX);

  return {
    shape,
    body: bodyCut.text,
    bodyTruncated: bodyCut.truncated,
    dropped: options.slice(limit),
    options: shown.map((option) => {
      const title = cut(option.label, titleMax);
      // A description is only ever shown on a list row. On buttons it is dropped
      // entirely, which is itself worth seeing in the preview.
      const description =
        shape === "list" && option.description ? cut(option.description, WA_LIST_DESCRIPTION_MAX) : null;
      return {
        id: option.id,
        title: title.text,
        titleTruncated: title.truncated,
        ...(description ? { description: description.text } : {}),
        descriptionTruncated: description?.truncated ?? false,
      };
    }),
  };
}

/** Body text of a plain text message, as it will arrive. */
export function renderWhatsAppText(text: string): { text: string; truncated: boolean } {
  return cut(text, WA_BODY_MAX);
}
