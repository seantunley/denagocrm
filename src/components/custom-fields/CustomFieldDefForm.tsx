"use client";

import { useState } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import {
  FIELD_TYPES,
  LINK_TARGETS,
  SHOW_WHEN_OPS,
  type CustomEntity,
  type FieldDef,
} from "@/lib/customFields-helpers";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * Create/edit one custom-field definition (Settings → Custom fields).
 *
 * Client-side so each setting appears only when it applies: options only for a
 * dropdown or tick-several, "links to" only for a link field, and the "show only
 * when" answer only once another field is picked — as a dropdown of that field's
 * own answers where it has them.
 */
export default function CustomFieldDefForm({
  entity,
  def,
  siblings,
  action,
  deleteSlot,
}: {
  entity: CustomEntity;
  def?: FieldDef;
  /** The other fields on the same record type — what "show only when" can follow. */
  siblings: FieldDef[];
  action: (formData: FormData) => Promise<ActionResult | void>;
  deleteSlot?: React.ReactNode;
}) {
  const isNew = !def;
  const idp = `${def?.id ?? "new"}-${entity}`;
  const [type, setType] = useState<string>(def?.type ?? "text");
  const [whenKey, setWhenKey] = useState(def?.showWhen?.key ?? "");
  const [whenOp, setWhenOp] = useState<string>(def?.showWhen?.op ?? "equals");
  const control = siblings.find((s) => s.key === whenKey) ?? null;
  const hasOptions = type === "select" || type === "multiselect";
  const answers =
    control?.type === "checkbox"
      ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
      : control && (control.type === "select" || control.type === "multiselect")
        ? control.options.map((o) => ({ value: o, label: o }))
        : null;

  return (
    <SaveForm action={action} resetOnSuccess={isNew} className="grid gap-3 sm:grid-cols-2">
      {def && <input type="hidden" name="id" value={def.id} />}
      <input type="hidden" name="entity" value={entity} />

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`label-${idp}`}>Label</label>
        <input id={`label-${idp}`} name="label" required defaultValue={def?.label ?? ""} className="input" placeholder="e.g. VAT number" />
      </div>

      <div>
        <label className="label" htmlFor={`type-${idp}`}>Type</label>
        <select id={`type-${idp}`} name="type" value={type} onChange={(e) => setType(e.target.value)} className="input">
          {FIELD_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </div>

      {hasOptions && (
        <div>
          <label className="label" htmlFor={`options-${idp}`}>Options</label>
          <textarea
            id={`options-${idp}`}
            name="options"
            rows={3}
            required
            defaultValue={def?.options.join("\n") ?? ""}
            className="input"
            placeholder="One option per line"
          />
        </div>
      )}

      {type === "link" && (
        <div>
          <label className="label" htmlFor={`linkTo-${idp}`}>Links to</label>
          <select id={`linkTo-${idp}`} name="linkTo" required defaultValue={def?.linkTo ?? ""} className="input">
            <option value="" disabled>Choose…</option>
            {LINK_TARGETS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      )}

      {siblings.length > 0 && (
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor={`when-${idp}`}>Show only when</label>
            <select id={`when-${idp}`} name="showWhenKey" value={whenKey} onChange={(e) => setWhenKey(e.target.value)} className="input">
              <option value="">Always show</option>
              {siblings.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
          {control && (
            <div>
              <label className="label" htmlFor={`whenop-${idp}`}>&nbsp;</label>
              <select id={`whenop-${idp}`} name="showWhenOp" value={whenOp} onChange={(e) => setWhenOp(e.target.value)} className="input">
                {SHOW_WHEN_OPS.filter((o) => control.type !== "checkbox" || o.id !== "filled").map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          {control && whenOp !== "filled" && (
            <div>
              <label className="label" htmlFor={`whenval-${idp}`}>&nbsp;</label>
              {answers ? (
                <select id={`whenval-${idp}`} name="showWhenValue" defaultValue={def?.showWhen?.value ?? answers[0]?.value} className="input">
                  {answers.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              ) : (
                <input id={`whenval-${idp}`} name="showWhenValue" required defaultValue={def?.showWhen?.value ?? ""} className="input" placeholder="Answer" />
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" name="required" defaultChecked={def?.required ?? false} className="size-4" />
          Required
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          {/* Checkbox submits "on" first (when ticked); the trailing hidden input
              provides an explicit "off" the server action reads when unticked. */}
          <input type="checkbox" name="active" value="on" defaultChecked={def?.active ?? true} className="size-4" />
          <input type="hidden" name="active" value="off" />
          Active
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        {deleteSlot ?? <span />}
        <SaveButton className="btn-primary btn-sm" pendingLabel="Saving…">{isNew ? "Add field" : "Save changes"}</SaveButton>
      </div>
    </SaveForm>
  );
}
