"use client";

import { useState } from "react";
import { Check, ChevronDown, ImageIcon, List, Scissors } from "lucide-react";
import type { OutMsg } from "@/lib/flow";
import {
  renderWhatsAppChoice,
  renderWhatsAppText,
  type RenderedChoice,
} from "@/lib/whatsappRendering";

/**
 * The draft, drawn the way WhatsApp will actually draw it.
 *
 * ── WHY THIS IS NOT DECORATION ──────────────────────────────────────────────
 *
 * The builder's simulator rendered every choice as a row of plain buttons,
 * untruncated. WhatsApp does something else, and the difference is not cosmetic:
 *
 *   three options or fewer  →  reply BUTTONS, titles cut at 20 characters
 *   four or more            →  a LIST behind a "Choose" sheet, cut at 24
 *
 * So adding a fourth option silently changes the interface AND the limit. A flow
 * could read perfectly in testing and arrive on a handset with a label cut
 * mid-word, or with its fourth branch hidden behind a menu the author never saw.
 * Everything on this screen comes from `whatsappRendering.ts`, which the live
 * transport imports too — a preview that disagreed with the sender would be
 * worse than none, because it would be believed.
 *
 * ── WHAT IT STILL CANNOT SHOW ───────────────────────────────────────────────
 *
 * Templates, the 24-hour customer-service window, media upload and delivery
 * receipts exist only on a live channel. This proves the message SHAPE, not
 * deliverability, and the footer says so rather than letting the frame imply it.
 */

export type PreviewLine =
  | { id: string; role: "customer"; text: string }
  | { id: string; role: "bot"; msg: OutMsg };

/** WhatsApp's own palette, so the eye judges it as the real thing would look. */
const INK = {
  canvas: "#0b141a",
  incoming: "#202c33",
  outgoing: "#005c4b",
  text: "#e9edef",
  meta: "#8696a0",
  divider: "rgba(233,237,239,0.12)",
  action: "#53bdeb",
};

function Ticks() {
  // Two blue ticks — the customer has read it. Cosmetic here on purpose: read
  // state is a live-channel fact, and the footer already says so.
  return (
    <span className="relative ml-1 inline-flex w-4 shrink-0 items-center" style={{ color: INK.action }}>
      <Check className="absolute size-3" strokeWidth={3} />
      <Check className="absolute left-1 size-3" strokeWidth={3} />
    </span>
  );
}

function CutBadge({ what }: { what: string }) {
  return (
    <span
      className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: "rgba(255,159,67,0.14)", color: "#ffb066" }}
      title={`WhatsApp will cut this ${what}. Shorten it in the builder.`}
    >
      <Scissors className="size-2.5" /> cut by WhatsApp
    </span>
  );
}

function Bubble({
  side,
  children,
  time,
}: {
  side: "in" | "out";
  children: React.ReactNode;
  time: string;
}) {
  const out = side === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className="relative max-w-[80%] rounded-lg px-2.5 py-1.5 text-[14.2px] leading-[19px] shadow-sm"
        style={{ background: out ? INK.outgoing : INK.incoming, color: INK.text }}
      >
        {children}
        <span className="float-right ml-2 mt-1 flex translate-y-0.5 items-center text-[11px]" style={{ color: INK.meta }}>
          {time}
          {out && <Ticks />}
        </span>
      </div>
    </div>
  );
}

/** Reply buttons sit BELOW the bubble, stacked and full width, divided by hairlines. */
function ReplyButtons({
  rendered,
  onPick,
  disabled,
}: {
  rendered: RenderedChoice;
  onPick: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-0.5 flex flex-col items-start gap-0.5">
      {rendered.options.map((option) => (
        <div key={option.id} className="w-[80%]">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(option.id)}
            className="w-full rounded-lg py-2 text-center text-[14px] font-medium transition-opacity disabled:opacity-50"
            style={{ background: INK.incoming, color: INK.action }}
          >
            {option.title}
          </button>
          {option.titleTruncated && <CutBadge what="button label at 20 characters" />}
        </div>
      ))}
    </div>
  );
}

/** A list is ONE button that opens a sheet — the options are not on the thread. */
function ListChoice({
  rendered,
  onPick,
  disabled,
}: {
  rendered: RenderedChoice;
  onPick: (id: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-0.5">
      <div className="w-[80%]">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[14px] font-medium disabled:opacity-50"
          style={{ background: INK.incoming, color: INK.action }}
        >
          <List className="size-4" /> Choose
        </button>
      </div>

      {open && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end" onClick={() => setOpen(false)}>
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} />
          <div
            className="relative max-h-[70%] overflow-y-auto rounded-t-2xl pb-2"
            style={{ background: INK.incoming }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <p className="text-[15px] font-medium" style={{ color: INK.text }}>Choose</p>
              <button type="button" onClick={() => setOpen(false)} style={{ color: INK.meta }}>
                <ChevronDown className="size-5" />
              </button>
            </div>
            {rendered.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => { setOpen(false); onPick(option.id); }}
                className="block w-full px-4 py-3 text-left disabled:opacity-50"
                style={{ borderTop: `1px solid ${INK.divider}` }}
              >
                <span className="text-[15px]" style={{ color: INK.text }}>{option.title}</span>
                {option.description && (
                  <span className="mt-0.5 block text-[13px]" style={{ color: INK.meta }}>{option.description}</span>
                )}
                {(option.titleTruncated || option.descriptionTruncated) && (
                  <CutBadge what={option.titleTruncated ? "row title at 24 characters" : "description at 72 characters"} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WhatsAppPreview({
  lines,
  onPick,
  disabled,
  businessName,
}: {
  lines: PreviewLine[];
  onPick: (id: string) => void;
  disabled: boolean;
  businessName: string;
}) {
  // A fixed clock, not `new Date()`. Every bubble showing a different minute as
  // the preview runs is noise, and a stable time keeps the eye on the message.
  const time = "09:41";
  /*
   * Only the newest choice is actionable. Earlier choice messages stay in the
   * transcript as history, but the simulator engine is waiting on choices from
   * the current node only. Leaving old buttons enabled made them appear live
   * while their ids could no longer be resolved, so a tap silently did nothing.
   */
  const activeChoiceLineId = lines.reduce<string | null>(
    (latest, entry) =>
      entry.role === "bot" && entry.msg.type === "choice" ? entry.id : latest,
    null,
  );

  return (
    <div className="relative flex-1 overflow-y-auto p-3" style={{ background: INK.canvas }}>
      <p className="mx-auto mb-3 w-fit rounded-md px-2 py-1 text-[11px]" style={{ background: "#1d282f", color: INK.meta }}>
        Preview only · nothing is sent and nothing is written
      </p>

      {lines.map((entry) => {
        if (entry.role === "customer") {
          return (
            <div key={entry.id} className="mb-1.5">
              <Bubble side="out" time={time}>
                <span className="whitespace-pre-wrap break-words">{entry.text}</span>
              </Bubble>
            </div>
          );
        }

        const msg = entry.msg;
        if (msg.type === "text") {
          const rendered = renderWhatsAppText(msg.text);
          return (
            <div key={entry.id} className="mb-1.5">
              <Bubble side="in" time={time}>
                <span className="whitespace-pre-wrap break-words">{rendered.text}</span>
                {rendered.truncated && <CutBadge what="message at 4096 characters" />}
              </Bubble>
            </div>
          );
        }

        if (msg.type === "image") {
          return (
            <div key={entry.id} className="mb-1.5">
              <Bubble side="in" time={time}>
                <span
                  className="mb-1 flex h-32 w-56 items-center justify-center rounded-md text-[12px]"
                  style={{ background: "rgba(255,255,255,0.06)", color: INK.meta }}
                >
                  <ImageIcon className="mr-1.5 size-4" /> image
                </span>
                {msg.caption && <span className="whitespace-pre-wrap break-words">{msg.caption}</span>}
              </Bubble>
            </div>
          );
        }

        const rendered = renderWhatsAppChoice(msg.text, msg.options);
        return (
          <div key={entry.id} className="mb-1.5">
            <Bubble side="in" time={time}>
              <span className="whitespace-pre-wrap break-words">{rendered.body}</span>
              {rendered.bodyTruncated && <CutBadge what="message at 1024 characters" />}
            </Bubble>
            {rendered.shape === "buttons" ? (
              <ReplyButtons
                rendered={rendered}
                onPick={onPick}
                disabled={disabled || entry.id !== activeChoiceLineId}
              />
            ) : (
              <ListChoice
                rendered={rendered}
                onPick={onPick}
                disabled={disabled || entry.id !== activeChoiceLineId}
              />
            )}
            {rendered.dropped.length > 0 && (
              <p
                className="mt-1 w-[80%] rounded-md px-2 py-1.5 text-[11px]"
                style={{ background: "rgba(255,99,71,0.12)", color: "#ff9d8a" }}
              >
                {rendered.dropped.length} option{rendered.dropped.length === 1 ? "" : "s"} past
                WhatsApp&apos;s limit and never shown to the customer:{" "}
                {rendered.dropped.map((o) => `“${o.label}”`).join(", ")}
              </p>
            )}
          </div>
        );
      })}

      <p className="mx-auto mt-4 w-fit px-3 text-center text-[10px] leading-4" style={{ color: INK.meta }}>
        {businessName} · shape only. Templates, the 24-hour window, media upload and
        delivery receipts exist on a live channel and are not simulated.
      </p>
    </div>
  );
}
