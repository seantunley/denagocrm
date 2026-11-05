"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { listMentionableStaff } from "@/app/actions/collaboration";
import { mentionQuery, mentionedIds } from "@/lib/collaborationRules";

type Person = { id: string; name: string };

/**
 * A note box where typing @ offers the workspace's staff. Picking someone writes "@Name" into the note and names
 * them in a `mentions` field the form sends with it; deleting "@Name" from the text un-mentions them. The staff list
 * is fetched the first time @ is typed (or passed in). Who may actually be told is decided on the server.
 *
 * Form mode: give it a `name` and it submits like a textarea. Controlled mode: `value` + `onChange(text, mentions)`.
 */
export default function MentionTextarea({
  name,
  value,
  onChange,
  staff: givenStaff,
  className = "input",
  rows = 3,
  placeholder,
  id,
  disabled,
}: {
  name?: string;
  value?: string;
  onChange?: (text: string, mentions: string[]) => void;
  staff?: Person[];
  className?: string;
  rows?: number;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [ownText, setOwnText] = useState("");
  const text = value ?? ownText;
  const [picked, setPicked] = useState<string[]>([]);
  const [staff, setStaff] = useState<Person[] | null>(givenStaff ?? null);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);

  // SaveForm clears a saved form with form.reset(), which can't reach state: empty the note when its form resets.
  useEffect(() => {
    const form = box.current?.form;
    if (!form || value !== undefined) return;
    const clear = () => { setOwnText(""); setPicked([]); setQuery(null); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, [value]);

  const people = staff ?? [];
  const matches = query ? people.filter((p) => p.name.toLowerCase().includes(query.query.toLowerCase())).slice(0, 6) : [];
  const mentions = mentionedIds(text, picked, people);

  const update = (next: string, nextPicked = picked) => {
    if (value === undefined) setOwnText(next);
    onChange?.(next, mentionedIds(next, nextPicked, people));
  };

  const look = (next: string, cursor: number) => {
    const found = mentionQuery(next, cursor);
    setQuery(found);
    setActive(0);
    if (found && staff === null) {
      setStaff([]);
      listMentionableStaff().then(setStaff).catch(() => setStaff([]));
    }
  };

  const choose = (person: Person) => {
    if (!query) return;
    const cursor = box.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, query.start)}@${person.name} ${text.slice(cursor)}`;
    const nextPicked = [...new Set([...picked, person.id])];
    setPicked(nextPicked);
    update(next, nextPicked);
    setQuery(null);
    const at = query.start + person.name.length + 2;
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matches.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((a) => (a + 1) % matches.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(matches[active]); }
    else if (event.key === "Escape") setQuery(null);
  };

  return (
    <div className="relative">
      <textarea
        ref={box}
        id={id}
        name={name}
        className={className}
        rows={rows}
        placeholder={placeholder ?? "Type @ to mention someone on your team"}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          update(event.target.value);
          look(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        aria-autocomplete="list"
      />
      {/* Controlled, so a re-render can't reset it (a ref-written hidden input reverts). */}
      {name && <input type="hidden" name="mentions" value={mentions.join(",")} />}
      {query && matches.length > 0 && (
        <ul role="listbox" className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1 text-sm shadow-lg">
          {matches.map((person, at) => (
            <li key={person.id} role="option" aria-selected={at === active}>
              <button
                type="button"
                className={`w-full px-3 py-1.5 text-left ${at === active ? "bg-muted" : "hover:bg-muted"}`}
                onMouseDown={(event) => { event.preventDefault(); choose(person); }}
              >
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query && staff !== null && people.length > 0 && matches.length === 0 && (
        <p className="absolute left-0 top-full z-30 mt-1 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-lg">No one on your team matches “{query.query}”.</p>
      )}
    </div>
  );
}
