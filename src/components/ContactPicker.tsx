"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { contactOptionById, searchLinkableContacts } from "@/app/actions/leads";
import { cn } from "@/lib/utils";

export type ContactOption = { id: string; label: string; sublabel?: string };

/**
 * THE customer picker (gap audit #23). Every customer `<select>` used to list the
 * first 500 contacts alphabetically, so customer 501 onwards could not be chosen
 * anywhere — and a record already linked to one rendered blank and lost the link
 * on save.
 *
 * `options` (the page's preloaded list) answers instantly; typing two or more
 * characters also searches every customer this person may see on the server.
 * A selected customer the page didn't preload is looked up by id, so it shows.
 *
 * Submits like the select it replaces: a hidden input called `name`.
 */
export default function ContactPicker({
  name,
  options,
  value,
  defaultValue = "",
  onChange,
  required = false,
  emptyLabel,
  placeholder = "Search customers by name, company, email or phone",
  className,
  id,
  disabled = false,
}: {
  disabled?: boolean;
  name: string;
  options: ContactOption[];
  /** Controlled value; leave undefined to use `defaultValue`. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string, option: ContactOption | null) => void;
  required?: boolean;
  /** Offered as the "no customer" choice when the field may be left empty. */
  emptyLabel?: string;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [own, setOwn] = useState(defaultValue);
  const selected = value ?? own;
  const [found, setFound] = useState<ContactOption[]>([]);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const latest = useRef("");
  const listId = useId();

  const known = useMemo(() => {
    const map = new Map<string, ContactOption>();
    for (const option of [...options, ...found]) if (!map.has(option.id)) map.set(option.id, option);
    return map;
  }, [options, found]);
  const current = selected ? known.get(selected) ?? null : null;

  // A selected customer the page didn't preload: fetch its label once.
  useEffect(() => {
    if (!selected || known.has(selected)) return;
    let live = true;
    contactOptionById(selected)
      // Kept selected either way — this picker never drops a link it can't label.
      .then((option) => {
        if (live) setFound((rows) => [...rows, option ?? { id: selected, label: "Current customer" }]);
      })
      .catch(() => {
        if (live) setFound((rows) => [...rows, { id: selected, label: "Current customer" }]);
      });
    return () => {
      live = false;
    };
  }, [selected, known]);

  // Server search, debounced; an older answer never repaints a newer query.
  useEffect(() => {
    const query = term.trim();
    latest.current = query;
    if (!open || query.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      searchLinkableContacts(query)
        .then((rows) => {
          if (latest.current === query) setFound((prev) => [...prev, ...rows.filter((row) => !prev.some((p) => p.id === row.id))]);
        })
        .catch(() => {})
        .finally(() => {
          if (latest.current === query) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [term, open]);

  const matches = useMemo(() => {
    const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...known.values()];
    const hits = words.length
      ? all.filter((option) => words.every((word) => `${option.label} ${option.sublabel ?? ""}`.toLowerCase().includes(word)))
      : all;
    return hits.slice(0, 50);
  }, [known, term]);

  const choices: Array<ContactOption | null> = emptyLabel ? [null, ...matches] : matches;

  function choose(option: ContactOption | null) {
    const next = option?.id ?? "";
    if (value === undefined) setOwn(next);
    onChange?.(next, option);
    setTerm("");
    setOpen(false);
  }

  return (
    <div className={cn("relative", className)}>
      <input type="hidden" name={name} value={selected} />
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          className="input pr-14"
          // Required is enforced on the visible box, which only holds text while
          // a customer is actually chosen — typed text is dropped on blur.
          required={required && !selected}
          value={open ? term : current?.label ?? (selected ? "Loading customer…" : "")}
          placeholder={emptyLabel && !selected ? emptyLabel : placeholder}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => {
            // Let a click on an option land before the list closes.
            setTimeout(() => {
              setOpen(false);
              setTerm("");
            }, 150);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, choices.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (choices[active] !== undefined) choose(choices[active]);
            } else if (event.key === "Escape") {
              setOpen(false);
              setTerm("");
            }
          }}
        />
        {selected && !required && !disabled && (
          <button
            type="button"
            aria-label="Clear customer"
            className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(null)}
          >
            <X className="size-3.5" />
          </button>
        )}
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </div>
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-[calc(100%+4px)] z-50 max-h-64 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-lg"
        >
          {choices.map((option, index) => (
            <li
              key={option?.id ?? "__none"}
              role="option"
              aria-selected={(option?.id ?? "") === selected}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5",
                index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span className={cn("truncate", option ? "font-medium" : "text-muted-foreground")}>{option?.label ?? emptyLabel}</span>
              {option?.sublabel && <span className="truncate text-xs text-muted-foreground">{option.sublabel}</span>}
            </li>
          ))}
          {term.trim().length >= 2 && searching && <li className="px-3 py-1.5 text-xs text-muted-foreground">Searching all customers…</li>}
          {matches.length === 0 && !searching && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              {term.trim().length < 2 ? "Type at least two characters to search." : "No customers match that."}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
