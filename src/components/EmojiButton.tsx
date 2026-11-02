"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A 😀 button that opens a grid of emojis and inserts the one clicked AT THE CURSOR of a text box (Sean, 2026-11-02:
 * "can we build a button to open the emoji picker?" — a browser cannot open the system picker itself). The box is
 * found by `targetId`; `value`/`onChange` are its own controlled state, so this never writes the DOM behind React.
 */
const EMOJI = [
  "😀", "😊", "😃", "😉", "🙂", "🤩", "😍", "🥳", "🙏", "👍", "👌", "👏", "🙌", "🤝", "👋", "💪",
  "✅", "✔️", "❌", "⭐", "🌟", "✨", "🔥", "⚡", "🎉", "🎁", "💯", "❤️", "💙", "💚", "📞", "📱",
  "💬", "📩", "📄", "📎", "📍", "🗓️", "⏰", "💰", "🏷️", "🛒", "🚗", "🛺", "🔋", "🔌", "🔧", "🛠️",
  "🏁", "🌍", "☀️", "🌴", "⛳", "🏌️", "👉", "👇", "➡️", "⬇️",
];

export function insertAtCursor(target: HTMLInputElement | HTMLTextAreaElement | null, value: string, text: string): { next: string; caret: number } {
  const start = target?.selectionStart ?? value.length;
  const end = target?.selectionEnd ?? value.length;
  return { next: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
}

export default function EmojiButton({ targetId, value, onChange }: { targetId: string; value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const pick = (emoji: string) => {
    const target = document.getElementById(targetId) as HTMLInputElement | HTMLTextAreaElement | null;
    const { next, caret } = insertAtCursor(target, value, emoji);
    onChange(next);
    setOpen(false);
    // Back into the box with the cursor after the emoji, once React has rendered the new value.
    requestAnimationFrame(() => { target?.focus(); target?.setSelectionRange(caret, caret); });
  };

  return (
    <div ref={box} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-md px-1.5 py-0.5 text-sm hover:bg-white/10" title="Insert an emoji" aria-label="Insert an emoji" aria-expanded={open}>😀</button>
      {open && (
        <div role="dialog" aria-label="Emojis" className="absolute right-0 z-50 mt-1 grid w-64 grid-cols-8 gap-0.5 rounded-xl border border-border bg-card p-2 shadow-xl">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" onClick={() => pick(emoji)} className="grid size-7 place-items-center rounded text-base hover:bg-white/10" aria-label={`Insert ${emoji}`}>{emoji}</button>
          ))}
        </div>
      )}
    </div>
  );
}
