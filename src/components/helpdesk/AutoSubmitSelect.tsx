"use client";

import { useRef } from "react";

/** A <select> that submits its enclosing <form> as soon as the value changes. */
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
  return (
    <select
      ref={ref}
      name={name}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      className={className ?? "input"}
      onChange={() => ref.current?.form?.requestSubmit()}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
