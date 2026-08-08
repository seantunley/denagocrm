"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Braces,
  ChevronDown,
  CircleCheck,
  CopyPlus,
  Eye,
  Filter,
  FolderPlus,
  Mail,
  MessageSquareText,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  archiveMarketingAudience,
  createMarketingAudience,
  previewMarketingAudience,
  updateMarketingAudience,
} from "@/app/actions/marketingContent";

type AudienceRule = {
  field: string;
  operator: string;
  value?: unknown;
  legacyCriteria?: Record<string, unknown>;
};
export type AudienceGroup = {
  operator: "AND" | "OR";
  rules: Array<AudienceRule | AudienceGroup>;
  exclusions?: Array<AudienceRule | AudienceGroup>;
};

type Option = { id: string; name: string };
type Audience = {
  id: string;
  name: string;
  ruleTree: unknown;
  status: string;
  lastCalculatedCount: number;
  lastCalculatedAt: string | null;
  updatedAt: string;
  explanation: string | null;
  version: number | null;
};

type Preview = Awaited<ReturnType<typeof previewMarketingAudience>>;
type ValueKind = "text" | "select" | "boolean" | "date" | "money";
type FieldDefinition = {
  value: string;
  label: string;
  kind: ValueKind;
  options?: Array<{ value: string; label: string }>;
  help: string;
};

const PROVINCES = [
  "Western Cape",
  "Eastern Cape",
  "Northern Cape",
  "Gauteng",
  "KwaZulu-Natal",
  "Free State",
  "North West",
  "Limpopo",
  "Mpumalanga",
];

const SOURCE_OPTIONS = ["manual", "facebook", "instagram", "website", "whatsapp"];
const QUOTE_STATUSES = ["draft", "sent", "viewed", "accepted", "rejected", "expired"];
const LEAD_STATUSES = ["open", "won", "lost"];

const OPERATOR_LABELS: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  in: "is any of",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  greater_than: "is greater than",
  greater_or_equal: "is at least",
  less_than: "is less than",
  less_or_equal: "is at most",
};

function fieldDefinitions(tags: Option[], products: Option[]): FieldDefinition[] {
  return [
    { value: "province", label: "Province", kind: "select", options: PROVINCES.map((value) => ({ value, label: value })), help: "Customer province" },
    { value: "source", label: "Lead source", kind: "select", options: SOURCE_OPTIONS.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })), help: "Where the customer originally came from" },
    { value: "tag", label: "Customer tag", kind: "select", options: tags.map((tag) => ({ value: tag.id, label: tag.name })), help: "Tags from this tenant only" },
    { value: "has_vehicle", label: "Owns a vehicle", kind: "boolean", help: "Has a vehicle on record" },
    { value: "vehicle_model", label: "Vehicle model", kind: "text", options: products.map((product) => ({ value: product.name, label: product.name })), help: "Vehicle model recorded against the customer" },
    { value: "bought_before", label: "Bought before", kind: "boolean", help: "Has a won opportunity" },
    { value: "service_due", label: "Service due", kind: "boolean", help: "Has a vehicle due soon or overdue for service" },
    { value: "lead_status", label: "Lead status", kind: "select", options: LEAD_STATUSES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })), help: "Status of any linked opportunity" },
    { value: "product_interest", label: "Product interest", kind: "select", options: products.map((product) => ({ value: product.id, label: product.name })), help: "Catalogue product linked to an opportunity" },
    { value: "created_date", label: "Customer created date", kind: "date", help: "When the customer record was created" },
    { value: "email_available", label: "Has email address", kind: "boolean", help: "An email address is available" },
    { value: "phone_available", label: "Has phone / WhatsApp", kind: "boolean", help: "A mobile, phone or WhatsApp number is available" },
    { value: "quote_status", label: "Quote status", kind: "select", options: QUOTE_STATUSES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })), help: "Status of any linked quote" },
    { value: "customer_value", label: "Customer value", kind: "money", help: "Total value of won opportunities" },
  ];
}

function operatorsFor(kind: ValueKind) {
  if (kind === "boolean") return ["equals", "not_equals"];
  if (kind === "date" || kind === "money") return ["equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal"];
  if (kind === "select") return ["equals", "not_equals", "in", "is_empty", "is_not_empty"];
  return ["equals", "not_equals", "contains", "in", "is_empty", "is_not_empty"];
}

function defaultValue(definition: FieldDefinition) {
  if (definition.kind === "boolean") return true;
  if (definition.kind === "money") return 0;
  if (definition.kind === "date") return new Date().toISOString().slice(0, 10);
  return definition.options?.[0]?.value ?? "";
}

function makeRule(definitions: FieldDefinition[]): AudienceRule {
  const definition = definitions[0];
  return { field: definition.value, operator: "equals", value: defaultValue(definition) };
}

function makeGroup(definitions: FieldDefinition[]): AudienceGroup {
  return { operator: "AND", rules: [makeRule(definitions)], exclusions: [] };
}

function asGroup(value: unknown, definitions: FieldDefinition[]): AudienceGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return makeGroup(definitions);
  const candidate = value as Partial<AudienceGroup>;
  if ((candidate.operator !== "AND" && candidate.operator !== "OR") || !Array.isArray(candidate.rules) || candidate.rules.length === 0) {
    return makeGroup(definitions);
  }
  return JSON.parse(JSON.stringify(candidate)) as AudienceGroup;
}

function isGroup(node: AudienceRule | AudienceGroup): node is AudienceGroup {
  return (node as AudienceGroup).operator === "AND" || (node as AudienceGroup).operator === "OR";
}

function formatRelative(iso: string | null) {
  if (!iso) return "Not calculated yet";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Calculated previously";
  return value.toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
}

function friendlyExplanation(value: string | null) {
  if (!value) return "Saved audience rules";
  return value
    .replaceAll("_", " ")
    .replace(/\bequals\b/g, "is")
    .replace(/\bnot equals\b/g, "is not")
    .replace(/^\(|\)$/g, "");
}

export default function AudienceWorkspace({
  audiences,
  tags,
  products,
}: {
  audiences: Audience[];
  tags: Option[];
  products: Option[];
}) {
  const router = useRouter();
  const definitions = useMemo(() => fieldDefinitions(tags, products), [tags, products]);
  const [editor, setEditor] = useState<"new" | string | null>(audiences.length === 0 ? "new" : null);
  const [name, setName] = useState("");
  const [tree, setTree] = useState<AudienceGroup>(() => makeGroup(definitions));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editingAudience = editor && editor !== "new" ? audiences.find((item) => item.id === editor) ?? null : null;

  function openNew() {
    setEditor("new");
    setName("");
    setTree(makeGroup(definitions));
    setPreview(null);
    setError(null);
    setMessage(null);
  }

  function openEdit(audience: Audience) {
    setEditor(audience.id);
    setName(audience.name);
    setTree(asGroup(audience.ruleTree, definitions));
    setPreview(null);
    setError(null);
    setMessage(null);
  }

  function duplicate(audience: Audience) {
    setEditor("new");
    setName(`${audience.name} copy`);
    setTree(asGroup(audience.ruleTree, definitions));
    setPreview(null);
    setError(null);
    setMessage(null);
  }

  function closeEditor() {
    setEditor(null);
    setPreview(null);
    setError(null);
    setMessage(null);
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("ruleTree", JSON.stringify(tree));
      form.set("channel", "any");
      setPreview(await previewMarketingAudience(form));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not calculate this audience");
    } finally {
      setPreviewing(false);
    }
  }

  async function saveAudience() {
    if (!name.trim()) {
      setError("Give this audience a name before saving it.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("name", name.trim());
      form.set("ruleTree", JSON.stringify(tree));
      if (editingAudience) await updateMarketingAudience(editingAudience.id, form);
      else await createMarketingAudience(form);
      setMessage(editingAudience ? "Audience version saved." : "Audience created.");
      router.refresh();
      setEditor(null);
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this audience");
    } finally {
      setSaving(false);
    }
  }

  async function archiveAudience(audience: Audience) {
    if (!window.confirm(`Archive “${audience.name}”? Campaigns already frozen to this audience keep their existing recipient snapshot.`)) return;
    setError(null);
    try {
      await archiveMarketingAudience(audience.id);
      if (editor === audience.id) closeEditor();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not archive this audience");
    }
  }

  return (
    <div className="space-y-5">
      <section className="card overflow-hidden p-0">
        <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <UsersRound className="size-4" />
              </span>
              <div>
                <h2 className="font-semibold">Audience builder</h2>
                <p className="text-xs text-muted-foreground">Build reusable customer groups without writing rule JSON.</p>
              </div>
            </div>
          </div>
          {!editor && (
            <button type="button" className="btn-primary" onClick={openNew}>
              <Plus className="size-4" /> New audience
            </button>
          )}
        </div>

        {editor ? (
          <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 space-y-5 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">{editingAudience ? "Edit audience" : "New audience"}</p>
                  <h3 className="mt-1 text-lg font-semibold">{editingAudience ? editingAudience.name : "Define who should be included"}</h3>
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={closeEditor} aria-label="Close audience editor">
                  <X className="size-4" /> Close
                </button>
              </div>

              <div>
                <label className="label" htmlFor="audience-workspace-name">Audience name</label>
                <input
                  id="audience-workspace-name"
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Western Cape Rover prospects"
                />
              </div>

              <div className="rounded-2xl border border-border bg-muted/15 p-4 sm:p-5">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">Include contacts</p>
                    <p className="text-xs text-muted-foreground">Choose whether every condition or any condition must match.</p>
                  </div>
                  <MatchToggle
                    value={tree.operator}
                    onChange={(operator) => setTree({ ...tree, operator })}
                  />
                </div>
                <GroupEditor
                  group={{ ...tree, exclusions: [] }}
                  definitions={definitions}
                  depth={0}
                  onChange={(next) => setTree({ ...next, exclusions: tree.exclusions ?? [] })}
                />
              </div>

              <div className="rounded-2xl border border-border bg-muted/15 p-4 sm:p-5">
                <div className="mb-4">
                  <p className="font-medium">Exclude contacts</p>
                  <p className="text-xs text-muted-foreground">Anyone matching any exclusion below is removed from the audience.</p>
                </div>
                <ExclusionEditor
                  nodes={tree.exclusions ?? []}
                  definitions={definitions}
                  onChange={(exclusions) => setTree({ ...tree, exclusions })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                <button type="button" className="btn-secondary" onClick={runPreview} disabled={previewing}>
                  <Eye className="size-4" /> {previewing ? "Calculating…" : "Preview audience"}
                </button>
                <button type="button" className="btn-primary" onClick={saveAudience} disabled={saving}>
                  <Save className="size-4" /> {saving ? "Saving…" : editingAudience ? "Save new version" : "Save audience"}
                </button>
              </div>
              {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              {message && <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">{message}</p>}
            </div>

            <aside className="border-t border-border bg-muted/10 p-5 sm:p-6 lg:border-l lg:border-t-0">
              <div className="sticky top-24 space-y-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Live preview</p>
                  <p className="mt-1 text-sm text-muted-foreground">Counts reflect current CRM data. Campaign launch recalculates and freezes the final recipient list.</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Metric icon={UsersRound} label="Match" value={preview?.total ?? "—"} />
                  <Metric icon={Mail} label="Email" value={preview?.emailCount ?? "—"} />
                  <Metric icon={MessageSquareText} label="Phone" value={preview?.smsCount ?? "—"} />
                </div>
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3">
                  <div className="flex gap-2">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    <div>
                      <p className="text-xs font-medium">Marketing consent enforced</p>
                      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Deleted contacts and customers who opted out of marketing are always excluded by the server.</p>
                    </div>
                  </div>
                </div>
                {preview ? (
                  <div>
                    <p className="mb-2 text-xs font-medium">Sample matches</p>
                    {preview.contacts.length === 0 ? (
                      <p className="rounded-xl border border-border bg-background/30 p-3 text-xs text-muted-foreground">No contacts currently match these rules.</p>
                    ) : (
                      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                        {preview.contacts.map((contact) => (
                          <div key={contact.id} className="rounded-xl border border-border bg-background/40 p-3">
                            <div className="flex items-start gap-2">
                              <UserRound className="mt-0.5 size-3.5 text-muted-foreground" />
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium">{contact.name || "Unnamed contact"}</p>
                                <p className="truncate text-[11px] text-muted-foreground">{contact.email || contact.phone || "No reachable channel"}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button type="button" onClick={runPreview} className="w-full rounded-xl border border-dashed border-border p-4 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30">
                    <Eye className="mb-2 size-4" /> Calculate this audience to see reachability and sample contacts.
                  </button>
                )}
              </div>
            </aside>
          </div>
        ) : (
          <div className="p-5 text-sm text-muted-foreground sm:p-6">Select an existing audience to edit it, or create a new one.</div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="font-semibold">Saved audiences</h2>
            <p className="text-xs text-muted-foreground">Versioned definitions with the most recent calculated count.</p>
          </div>
          <span className="badge">{audiences.length} total</span>
        </div>
        {audiences.length === 0 ? (
          <div className="card border-dashed py-10 text-center">
            <Filter className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 font-medium">No saved audiences yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Your first audience will appear here with its calculated reach.</p>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {audiences.map((audience) => (
              <article key={audience.id} className={`card flex min-h-52 flex-col ${audience.status === "archived" ? "opacity-65" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{audience.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{audience.lastCalculatedCount.toLocaleString("en-ZA")} contacts · {formatRelative(audience.lastCalculatedAt)}</p>
                  </div>
                  <span className="badge shrink-0">{audience.status}</span>
                </div>
                <div className="mt-4 flex-1 rounded-xl border border-border bg-muted/20 p-3">
                  <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">{friendlyExplanation(audience.explanation)}</p>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Version {audience.version ?? "—"}</span>
                  <span>Updated {new Date(audience.updatedAt).toLocaleDateString("en-ZA")}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                  {audience.status !== "archived" && (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => openEdit(audience)}>
                      <Pencil className="size-3.5" /> Edit
                    </button>
                  )}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => duplicate(audience)}>
                    <CopyPlus className="size-3.5" /> Duplicate
                  </button>
                  {audience.status !== "archived" && (
                    <button type="button" className="btn-danger btn-sm" onClick={() => archiveAudience(audience)}>
                      <Archive className="size-3.5" /> Archive
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <details className="card group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
          <span className="flex items-center gap-2"><Braces className="size-4 text-muted-foreground" /> About audience rules</span>
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">The visual builder stores the same versioned rule-tree format used by the campaign engine. Raw JSON is intentionally no longer the normal editing interface; validation, tenant ownership and consent rules remain enforced on the server.</p>
      </details>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof UsersRound; label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <Icon className="size-3.5 text-muted-foreground" />
      <p className="mt-2 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function MatchToggle({ value, onChange }: { value: "AND" | "OR"; onChange: (value: "AND" | "OR") => void }) {
  return (
    <div className="inline-flex rounded-xl border border-border bg-background/50 p-1 text-xs">
      <button type="button" onClick={() => onChange("AND")} className={`rounded-lg px-3 py-1.5 ${value === "AND" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>ALL</button>
      <button type="button" onClick={() => onChange("OR")} className={`rounded-lg px-3 py-1.5 ${value === "OR" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>ANY</button>
    </div>
  );
}

function GroupEditor({
  group,
  definitions,
  depth,
  onChange,
  removable = false,
  onRemove,
}: {
  group: AudienceGroup;
  definitions: FieldDefinition[];
  depth: number;
  onChange: (group: AudienceGroup) => void;
  removable?: boolean;
  onRemove?: () => void;
}) {
  function replaceRule(index: number, node: AudienceRule | AudienceGroup) {
    const rules = [...group.rules];
    rules[index] = node;
    onChange({ ...group, rules });
  }
  function removeRule(index: number) {
    if (group.rules.length === 1) return;
    onChange({ ...group, rules: group.rules.filter((_, current) => current !== index) });
  }

  return (
    <div className={depth > 0 ? "rounded-xl border border-border bg-background/30 p-3" : "space-y-2"}>
      {depth > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium"><FolderPlus className="size-3.5" /> Condition group</span>
          <div className="flex items-center gap-2">
            <MatchToggle value={group.operator} onChange={(operator) => onChange({ ...group, operator })} />
            {removable && onRemove && <button type="button" onClick={onRemove} className="btn-danger btn-sm" aria-label="Remove condition group"><Trash2 className="size-3.5" /></button>}
          </div>
        </div>
      )}
      <div className="space-y-2">
        {group.rules.map((node, index) => (
          <div key={`${depth}-${index}`}>
            {isGroup(node) ? (
              <GroupEditor
                group={node}
                definitions={definitions}
                depth={depth + 1}
                onChange={(next) => replaceRule(index, next)}
                removable
                onRemove={() => removeRule(index)}
              />
            ) : (
              <RuleEditor
                rule={node}
                definitions={definitions}
                onChange={(next) => replaceRule(index, next)}
                onRemove={() => removeRule(index)}
                canRemove={group.rules.length > 1}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange({ ...group, rules: [...group.rules, makeRule(definitions)] })}>
          <Plus className="size-3.5" /> Add condition
        </button>
        {depth < 4 && (
          <button type="button" className="btn-secondary btn-sm" onClick={() => onChange({ ...group, rules: [...group.rules, makeGroup(definitions)] })}>
            <FolderPlus className="size-3.5" /> Add group
          </button>
        )}
      </div>
    </div>
  );
}

function ExclusionEditor({
  nodes,
  definitions,
  onChange,
}: {
  nodes: Array<AudienceRule | AudienceGroup>;
  definitions: FieldDefinition[];
  onChange: (nodes: Array<AudienceRule | AudienceGroup>) => void;
}) {
  function replace(index: number, node: AudienceRule | AudienceGroup) {
    const next = [...nodes];
    next[index] = node;
    onChange(next);
  }
  return (
    <div className="space-y-2">
      {nodes.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No custom exclusions. Marketing opt-outs are still excluded automatically.</p>}
      {nodes.map((node, index) => isGroup(node) ? (
        <GroupEditor
          key={index}
          group={node}
          definitions={definitions}
          depth={1}
          onChange={(next) => replace(index, next)}
          removable
          onRemove={() => onChange(nodes.filter((_, current) => current !== index))}
        />
      ) : (
        <RuleEditor
          key={index}
          rule={node}
          definitions={definitions}
          onChange={(next) => replace(index, next)}
          canRemove
          onRemove={() => onChange(nodes.filter((_, current) => current !== index))}
        />
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange([...nodes, makeRule(definitions)])}>
          <Plus className="size-3.5" /> Add exclusion
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange([...nodes, makeGroup(definitions)])}>
          <FolderPlus className="size-3.5" /> Add exclusion group
        </button>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  definitions,
  onChange,
  onRemove,
  canRemove,
}: {
  rule: AudienceRule;
  definitions: FieldDefinition[];
  onChange: (rule: AudienceRule) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  if (rule.legacyCriteria) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
        <div><p className="text-xs font-medium">Historical audience criteria</p><p className="text-[11px] text-muted-foreground">Replace this legacy rule with a current visual condition before changing its meaning.</p></div>
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange(makeRule(definitions))}>Replace</button>
      </div>
    );
  }

  const definition = definitions.find((item) => item.value === rule.field) ?? definitions[0];
  const operators = operatorsFor(definition.kind);
  const operator = operators.includes(rule.operator) ? rule.operator : operators[0];
  const valueHidden = operator === "is_empty" || operator === "is_not_empty";

  function changeField(field: string) {
    const next = definitions.find((item) => item.value === field) ?? definitions[0];
    onChange({ field: next.value, operator: operatorsFor(next.kind)[0], value: defaultValue(next) });
  }

  return (
    <div className="grid gap-2 rounded-xl border border-border bg-background/35 p-3 md:grid-cols-[minmax(9rem,1.15fr)_minmax(8rem,.8fr)_minmax(10rem,1fr)_auto] md:items-center">
      <div>
        <label className="sr-only">Field</label>
        <select className="input" value={definition.value} onChange={(event) => changeField(event.target.value)}>
          {definitions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div>
        <label className="sr-only">Operator</label>
        <select
          className="input"
          value={operator}
          onChange={(event) => {
            const nextOperator = event.target.value;
            onChange({ ...rule, operator: nextOperator, value: ["is_empty", "is_not_empty"].includes(nextOperator) ? undefined : rule.value ?? defaultValue(definition) });
          }}
        >
          {operators.map((item) => <option key={item} value={item}>{OPERATOR_LABELS[item] ?? item}</option>)}
        </select>
      </div>
      <div>
        {valueHidden ? (
          <div className="flex h-10 items-center rounded-xl border border-dashed border-border px-3 text-xs text-muted-foreground">No value needed</div>
        ) : (
          <ValueEditor definition={definition} operator={operator} value={rule.value} onChange={(value) => onChange({ ...rule, operator, value })} />
        )}
      </div>
      <button type="button" onClick={onRemove} disabled={!canRemove} className="btn-secondary btn-sm md:size-10 md:p-0" aria-label="Remove condition">
        <Trash2 className="size-3.5" />
      </button>
      <p className="text-[10px] leading-4 text-muted-foreground md:col-span-4">{definition.help}</p>
    </div>
  );
}

function ValueEditor({
  definition,
  operator,
  value,
  onChange,
}: {
  definition: FieldDefinition;
  operator: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (definition.kind === "boolean") {
    return (
      <select className="input" value={String(value ?? true)} onChange={(event) => onChange(event.target.value === "true")}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  if (definition.kind === "money") {
    const cents = Number(value ?? 0);
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
        <input type="number" min="0" step="0.01" className="input pl-7" value={Number.isFinite(cents) ? cents / 100 : 0} onChange={(event) => onChange(Math.round(Number(event.target.value || 0) * 100))} />
      </div>
    );
  }

  if (definition.kind === "date") {
    return <input type="date" className="input" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />;
  }

  if (definition.kind === "select" && operator === "in") {
    const values = Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").filter(Boolean);
    return (
      <select multiple className="input min-h-24 py-2" value={values} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>
        {(definition.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  if (definition.kind === "select") {
    return (
      <select className="input" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        {(definition.options ?? []).length === 0 && <option value="">No options available</option>}
        {(definition.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  if (operator === "in") {
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return <input className="input" value={text} onChange={(event) => onChange(event.target.value.split(",").map((part) => part.trim()).filter(Boolean))} placeholder="Value one, value two" />;
  }

  const listId = `audience-options-${definition.value}`;
  return (
    <>
      <input className="input" list={definition.options?.length ? listId : undefined} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} placeholder="Enter value" />
      {definition.options?.length ? <datalist id={listId}>{definition.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist> : null}
    </>
  );
}
