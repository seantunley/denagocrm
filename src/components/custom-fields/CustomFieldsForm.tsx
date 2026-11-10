"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ContactPicker from "@/components/ContactPicker";
import {
  displayValue,
  isFieldShown,
  multiValues,
  type FieldDef,
  type FieldWithValue,
  type LinkChoices,
} from "@/lib/customFields-helpers";
import type { ActionResult } from "@/lib/actionResultTypes";

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";

function Field({
  def,
  value,
  links,
  onValue,
}: {
  def: FieldDef;
  value: string | null;
  links: LinkChoices;
  /** Reports the live answer, so fields that "show only when…" can follow it. */
  onValue: (value: string | null) => void;
}) {
  const name = `cf_${def.id}`;
  const common = {
    id: name,
    name,
    className: inputCls,
    required: def.required,
    onChange: (e: { target: { value: string } }) => onValue(e.target.value),
  };
  switch (def.type) {
    case "textarea":
      return <textarea {...common} rows={3} defaultValue={value ?? ""} />;
    case "number":
      return <input {...common} type="number" step="any" defaultValue={value ?? ""} />;
    case "currency":
      return <input {...common} type="number" step="0.01" inputMode="decimal" placeholder="0.00" defaultValue={value ?? ""} />;
    case "date":
      return <input {...common} type="date" defaultValue={value ?? ""} />;
    case "url":
      return <input {...common} type="url" placeholder="https://…" defaultValue={value ?? ""} />;
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={name}
            name={name}
            type="checkbox"
            defaultChecked={value === "true"}
            onChange={(e) => onValue(e.target.checked ? "true" : "false")}
            className="size-4"
          />
          <span className="text-muted-foreground">Yes</span>
        </label>
      );
    case "select":
      return (
        <select {...common} defaultValue={value ?? ""}>
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    case "multiselect": {
      return <MultiSelect def={def} value={value} onValue={onValue} />;
    }
    case "link": {
      if (def.linkTo === "contact") {
        return (
          <ContactPicker
            id={name}
            name={name}
            options={links.contact ?? []}
            defaultValue={value ?? ""}
            emptyLabel="No contact"
            required={def.required}
            onChange={(id) => onValue(id || null)}
          />
        );
      }
      const choices = (def.linkTo && links[def.linkTo]) ?? [];
      return (
        <select {...common} defaultValue={value ?? ""}>
          <option value="">—</option>
          {value && !choices.some((c) => c.id === value) && <option value={value}>A record you can&apos;t open</option>}
          {choices.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      );
    }
    default:
      return <input {...common} type="text" defaultValue={value ?? ""} />;
  }
}

/** Tick-several: one checkbox per option, all named `cf_<id>`; the action reads them with getAll. */
function MultiSelect({ def, value, onValue }: { def: FieldDef; value: string | null; onValue: (value: string | null) => void }) {
  const [picked, setPicked] = useState(() => multiValues(value));
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {def.options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name={`cf_${def.id}`}
            value={o}
            checked={picked.includes(o)}
            onChange={(e) => {
              const next = e.target.checked ? [...picked, o] : picked.filter((p) => p !== o);
              setPicked(next);
              onValue(JSON.stringify(next));
            }}
            className="size-4"
          />
          {o}
        </label>
      ))}
    </div>
  );
}

/**
 * The custom-fields card, rendered from already-loaded field data.
 *
 * Split out of CustomFieldsCard so the quote EDITOR can show the same card. The
 * card is an async server component that reads the values itself, which a
 * client dialog cannot render — and the editor may not even have a record to
 * read when it opens. Both surfaces now render this, so the two can't drift.
 *
 * Fields with "Show only when…" follow the live answers: a hidden field's inputs
 * are disabled, so they are not posted, and the save action skips it the same
 * way (it re-checks against what was posted).
 *
 * Types and displayValue come from customFields-helpers, which is deliberately
 * free of the `server-only` and Prisma imports that customFields.ts carries.
 */
export default function CustomFieldsForm({
  fields,
  action,
  readOnly = false,
  links: givenLinks,
  loadLinks,
  className = "rounded-xl border border-border bg-card p-4 shadow-sm",
}: {
  fields: FieldWithValue[];
  /** Bound saveCustomFieldValues(entity, recordId). Unused when readOnly. */
  action: (formData: FormData) => Promise<ActionResult | void>;
  readOnly?: boolean;
  /** What link fields may point at, when the page loaded them. */
  links?: LinkChoices;
  /** Otherwise, how to fetch them (the quote dialog). Only called when there is a link field. */
  loadLinks?: () => Promise<LinkChoices>;
  className?: string;
}) {
  const [values, setValues] = useState<Map<string, string | null>>(
    () => new Map(fields.map((f) => [f.def.key, f.value])),
  );
  const [fetchedLinks, setFetchedLinks] = useState<LinkChoices>({});
  const hasLink = fields.some((f) => f.def.type === "link");
  // Once per mount: callers pass a fresh `.bind(...)` every render, so it can't be a dependency.
  const loader = useRef(loadLinks);
  const needsFetch = !givenLinks && hasLink;
  useEffect(() => {
    if (!needsFetch || !loader.current) return;
    let live = true;
    loader.current().then((l) => live && setFetchedLinks(l)).catch(() => {});
    return () => {
      live = false;
    };
  }, [needsFetch]);
  const links = givenLinks ?? fetchedLinks;
  const defsByKey = useMemo(() => new Map(fields.map((f) => [f.def.key, f.def])), [fields]);

  if (fields.length === 0) return null;
  const shown = (def: FieldDef) => isFieldShown(def, defsByKey, values);

  if (readOnly) {
    return (
      <div className={className}>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Custom fields
        </p>
        <div className="space-y-3">
          {fields.filter(({ def }) => shown(def)).map(({ def, value }) => (
            <div key={def.id}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{def.label}</label>
              <p className="text-sm">{displayValue(def, value, links)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <SaveForm
      action={action}
      success="Custom fields saved"
      resetOnSuccess={false}
      closeModalOnSuccess={false}
      className={className}
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Custom fields
      </p>
      <div className="space-y-3">
        {fields.map(({ def, value }) => {
          const visible = shown(def);
          return (
            // Kept mounted while hidden, so an answer typed before it was hidden is still there if it comes back.
            <fieldset key={def.id} disabled={!visible} hidden={!visible} className="min-w-0">
              <label htmlFor={`cf_${def.id}`} className="mb-1 block text-xs font-medium text-muted-foreground">
                {def.label}
                {def.required && <span className="text-destructive"> *</span>}
              </label>
              <Field
                def={def}
                value={value}
                links={links}
                onValue={(next) => setValues((current) => new Map(current).set(def.key, next))}
              />
            </fieldset>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end">
        <SaveButton pendingLabel="Saving…" className="btn-secondary btn-sm">Save custom fields</SaveButton>
      </div>
    </SaveForm>
  );
}
