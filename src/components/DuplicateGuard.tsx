"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { findPossibleDuplicates } from "@/app/actions/ai";

type Match = { id: string; label: string; detail: string };

/**
 * Watches the surrounding form's name/email/phone fields and warns — without
 * blocking — when someone who looks the same already exists.
 */
export default function DuplicateGuard() {
  const anchor = useRef<HTMLDivElement>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout>;

    const read = () => {
      const get = (sel: string) =>
        (form.querySelector(sel) as HTMLInputElement | null)?.value ?? "";
      const first = get('[name="firstName"]');
      const last = get('[name="lastName"]');
      const name = get('[name="name"]') || `${first} ${last}`.trim();
      return { name, email: get('[name="email"]'), phone: get('[name="phone"]') };
    };

    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (!["name", "firstName", "lastName", "email", "phone"].includes(t.name)) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const { name, email, phone } = read();
        if (!name && !email && !phone) return setMatches([]);
        try {
          setMatches(await findPossibleDuplicates({ name, email, phone }));
          setDismissed(false);
        } catch {
          /* never block capture */
        }
      }, 700);
    };
    form.addEventListener("input", onInput);
    return () => {
      form.removeEventListener("input", onInput);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={anchor}>
      {matches.length > 0 && !dismissed && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-3">
          <span>⚠</span>
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium text-amber-200 mb-1">Possibly already in the CRM:</p>
            {matches.map((m) => (
              <p key={m.id} className="text-xs text-amber-100/90 truncate">
                <Link href={`/contacts/${m.id}`} target="_blank" className="underline font-medium">
                  {m.label}
                </Link>{" "}
                — {m.detail}
              </p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-amber-300/60 hover:text-amber-200 cursor-pointer text-xs"
            title="It's someone else — continue"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
