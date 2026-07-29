"use client";

import { useRef } from "react";

import { useSavePending } from "@/components/SaveForm";

/**
 * A `<select>` that submits its enclosing form as soon as the value changes.
 *
 * Disabled while that save is in flight. SaveForm ignores a second submission
 * while one is pending, so leaving this interactive meant a quick second change
 * was accepted by the control, shown to the person, and then silently dropped —
 * the select would sit there displaying a value the database never received.
 * Blocking the change is honest: the person sees the control is busy and their
 * second choice is not quietly lost.
 */
export function AutoSubmitSelect({
  name,
  defaultValue,
  options,
  className,
  "aria-label": ariaLabel,
}: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  className?: string;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const pending = useSavePending();
  return (
    <select
      ref={ref}
      name={name}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      disabled={pending}
      aria-busy={pending}
      className={`${className ?? "input"} disabled:cursor-wait disabled:opacity-70`}
      onChange={() => {
        if (pending) return;
        ref.current?.form?.requestSubmit();
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
