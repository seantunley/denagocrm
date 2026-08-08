"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  CopyPlus,
  FileText,
  Mail,
  MessageSquareText,
  Pencil,
  Plus,
  Save,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  archiveMarketingTemplate,
  publishMarketingTemplate,
  saveMarketingTemplate,
} from "@/app/actions/marketingContent";
import ConfirmActionDialog from "@/components/marketing/ConfirmActionDialog";

type Template = {
  id: string;
  name: string;
  subject: string;
  body: string;
  plainTextBody: string | null;
  category: string;
  status: string;
  version: number;
};

type Category = {
  value: string;
  label: string;
  description: string;
  channel: "email" | "sms" | "internal";
};

const CATEGORIES: Category[] = [
  { value: "marketing_email", label: "Marketing email", description: "Promotions, launches and newsletters", channel: "email" },
  { value: "marketing_sms", label: "Marketing SMS", description: "Short promotional customer messages", channel: "sms" },
  { value: "transactional_email", label: "Transactional email", description: "Customer-triggered operational email", channel: "email" },
  { value: "transactional_sms", label: "Transactional SMS", description: "Customer-triggered operational SMS", channel: "sms" },
  { value: "service_reminder", label: "Service reminder", description: "Scheduled service and maintenance follow-up", channel: "email" },
  { value: "survey_invite_email", label: "Survey invite email", description: "Email invitations to governed surveys", channel: "email" },
  { value: "survey_invite_sms", label: "Survey invite SMS", description: "SMS invitations to governed surveys", channel: "sms" },
  { value: "internal_notification", label: "Internal notification", description: "Reusable internal team messaging", channel: "internal" },
];

const LEGACY_CATEGORIES: Record<string, Category> = {
  transactional: { value: "transactional", label: "Transactional (legacy)", description: "Historical transactional template", channel: "email" },
  service: { value: "service", label: "Service (legacy)", description: "Historical service template", channel: "email" },
  survey: { value: "survey", label: "Survey (legacy)", description: "Historical survey template", channel: "email" },
  internal: { value: "internal", label: "Internal (legacy)", description: "Historical internal template", channel: "internal" },
};

const EMPTY_DRAFT = {
  id: null as string | null,
  name: "",
  subject: "",
  body: "",
  plainTextBody: "",
  category: "marketing_email",
};

function categoryFor(value: string): Category {
  return CATEGORIES.find((category) => category.value === value)
    ?? LEGACY_CATEGORIES[value]
    ?? { value, label: value.replaceAll("_", " "), description: "Existing template category", channel: "email" };
}

function stripMarkup(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function TemplateWorkspace({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [editorOpen, setEditorOpen] = useState(templates.length === 0);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [previewMode, setPreviewMode] = useState<"rendered" | "plain">("rendered");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      const statusMatch = status === "all"
        || (status === "active" && template.status !== "archived")
        || template.status === status;
      const queryMatch = !needle || `${template.name} ${template.subject} ${template.category}`.toLowerCase().includes(needle);
      return statusMatch && queryMatch;
    });
  }, [query, status, templates]);

  const selectedCategory = categoryFor(draft.category);
  const isEmail = selectedCategory.channel === "email";
  const isSms = selectedCategory.channel === "sms";
  const canSave = Boolean(draft.name.trim() && draft.body.trim() && (!isEmail || draft.subject.trim()));

  function clearFeedback() {
    setError(null);
    setMessage(null);
  }

  function openNew() {
    setDraft({ ...EMPTY_DRAFT });
    setEditorOpen(true);
    setPreviewMode("rendered");
    clearFeedback();
  }

  function openEdit(template: Template) {
    setDraft({
      id: template.id,
      name: template.name,
      subject: template.subject,
      body: template.body,
      plainTextBody: template.plainTextBody ?? "",
      category: template.category,
    });
    setEditorOpen(true);
    setPreviewMode("rendered");
    clearFeedback();
  }

  function duplicate(template: Template) {
    setDraft({
      id: null,
      name: `${template.name} copy`,
      subject: template.subject,
      body: template.body,
      plainTextBody: template.plainTextBody ?? "",
      category: CATEGORIES.some((category) => category.value === template.category) ? template.category : "marketing_email",
    });
    setEditorOpen(true);
    setPreviewMode("rendered");
    clearFeedback();
  }

  function closeEditor() {
    setEditorOpen(false);
    setDraft({ ...EMPTY_DRAFT });
    clearFeedback();
  }

  function insertVariable(variable: string) {
    setDraft((current) => ({
      ...current,
      body: `${current.body}${current.body && !current.body.endsWith(" ") ? " " : ""}${variable}`,
    }));
  }

  async function save() {
    if (!canSave) {
      setError(isEmail && !draft.subject.trim() ? "Email templates need a subject." : "Template name and message content are required.");
      return;
    }
    setSaving(true);
    clearFeedback();
    try {
      const form = new FormData();
      if (draft.id) form.set("id", draft.id);
      form.set("name", draft.name.trim());
      form.set("category", draft.category);
      form.set("subject", draft.subject.trim());
      form.set("body", draft.body);
      form.set("plainTextBody", draft.plainTextBody);
      await saveMarketingTemplate(form);
      setMessage(draft.id ? "Draft version saved." : "Draft template created.");
      setEditorOpen(false);
      setDraft({ ...EMPTY_DRAFT });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="card overflow-hidden p-0">
        <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><FileText className="size-4" /></span>
            <div><h2 className="font-semibold">Template library</h2><p className="text-xs text-muted-foreground">Create once, preview clearly and publish an immutable version when it is ready.</p></div>
          </div>
          {!editorOpen && <button type="button" className="btn-primary" onClick={openNew}><Plus className="size-4" /> New template</button>}
        </div>

        {editorOpen && (
          <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="min-w-0 space-y-5 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">{draft.id ? "Edit draft" : "New template"}</p><h3 className="mt-1 text-lg font-semibold">{draft.name.trim() || "Compose reusable content"}</h3></div>
                <button type="button" className="btn-secondary btn-sm" onClick={closeEditor}><X className="size-4" /> Close</button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="label" htmlFor="marketing-template-name">Template name</label>
                  <input id="marketing-template-name" className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. New customer welcome" />
                </div>
                <div>
                  <label className="label" htmlFor="marketing-template-category">Purpose & channel</label>
                  <select id="marketing-template-category" className="input" value={draft.category} onChange={(event) => { const category = event.target.value; const next = categoryFor(category); setDraft({ ...draft, category, subject: next.channel === "email" ? draft.subject : "" }); }}>
                    {!CATEGORIES.some((category) => category.value === draft.category) && <option value={draft.category}>{categoryFor(draft.category).label}</option>}
                    {CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                  </select>
                  <p className="mt-1 text-[11px] text-muted-foreground">{selectedCategory.description}</p>
                </div>
              </div>

              {isEmail && <div><label className="label" htmlFor="marketing-template-subject">Email subject</label><input id="marketing-template-subject" className="input" value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} placeholder="Write a clear, useful subject line" /></div>}

              <div>
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div><label className="label mb-0" htmlFor="marketing-template-body">Message content</label><p className="mt-1 text-[11px] text-muted-foreground">{isEmail ? "HTML is supported, but plain text is fine too." : isSms ? "Keep it concise; the character count updates live." : "Reusable content for internal notifications."}</p></div>
                  <div className="flex flex-wrap gap-1.5"><button type="button" className="btn-secondary btn-sm" onClick={() => insertVariable("{{first_name}}")}>+ First name</button><button type="button" className="btn-secondary btn-sm" onClick={() => insertVariable("{{name}}")}>+ Full name</button></div>
                </div>
                <textarea id="marketing-template-body" className="input min-h-72 resize-y font-mono text-xs leading-6" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder={isSms ? "Hi {{first_name}}, your message…" : "Hi {{first_name}},\n\nWrite your reusable message here…"} />
                {isSms && <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">{draft.body.length} characters</p>}
              </div>

              {isEmail && (
                <details className="rounded-xl border border-border bg-muted/10 p-3">
                  <summary className="cursor-pointer text-xs font-medium">Plain-text fallback</summary>
                  <p className="mt-2 text-[11px] text-muted-foreground">Optional fallback for mail clients that do not render HTML.</p>
                  <textarea className="input mt-2 min-h-32 resize-y text-xs" value={draft.plainTextBody} onChange={(event) => setDraft({ ...draft, plainTextBody: event.target.value })} placeholder="Plain-text version" />
                </details>
              )}

              <div className="flex flex-wrap gap-2 border-t border-border pt-5"><button type="button" className="btn-primary" onClick={save} disabled={saving || !canSave}><Save className="size-4" /> {saving ? "Saving…" : draft.id ? "Save new version" : "Save draft"}</button><button type="button" className="btn-secondary" onClick={closeEditor}>Cancel</button></div>
              {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            </div>

            <aside className="border-t border-border bg-muted/10 p-5 sm:p-6 xl:border-l xl:border-t-0">
              <div className="sticky top-24 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Preview</p><p className="mt-1 text-xs text-muted-foreground">See the reusable content before saving.</p></div>
                  {isEmail && <div className="inline-flex rounded-lg border border-border bg-background/50 p-1 text-[11px]"><button type="button" className={`rounded-md px-2 py-1 ${previewMode === "rendered" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setPreviewMode("rendered")}>Rendered</button><button type="button" className={`rounded-md px-2 py-1 ${previewMode === "plain" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setPreviewMode("plain")}>Plain</button></div>}
                </div>

                {isEmail ? (
                  <div className="overflow-hidden rounded-2xl border border-border bg-background">
                    <div className="border-b border-border p-3"><div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground"><Mail className="size-3.5" /> Email preview</div><p className="text-sm font-medium">{draft.subject.trim() || "Your email subject"}</p></div>
                    {previewMode === "plain" ? <pre className="min-h-72 whitespace-pre-wrap break-words p-4 font-sans text-xs leading-5">{draft.plainTextBody || stripMarkup(draft.body) || "Your message preview will appear here."}</pre> : <iframe title="Template email preview" sandbox="" srcDoc={draft.body || "<div style='font-family: sans-serif; color: #777; padding: 20px'>Your message preview will appear here.</div>"} className="h-80 w-full bg-white" />}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-border bg-background/60 p-4"><div className="mb-4 flex items-center gap-2 text-[11px] text-muted-foreground"><MessageSquareText className="size-3.5" /> {isSms ? "SMS preview" : "Notification preview"}</div><div className="ml-auto max-w-[92%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-5 text-primary-foreground">{draft.body || "Your message preview will appear here."}</div></div>
                )}

                <div className="rounded-xl border border-primary/20 bg-primary/5 p-3"><div className="flex gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-primary" /><p className="text-[11px] leading-4 text-muted-foreground">Personalisation variables resolve at send time. Published versions stay immutable for auditability.</p></div></div>
              </div>
            </aside>
          </div>
        )}
      </section>

      {message && <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">{message}</p>}
      {error && !editorOpen && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div><h2 className="font-semibold">Saved templates</h2><p className="text-xs text-muted-foreground">Draft, publish and reuse templates without editing published content in place.</p></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-56"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input className="input pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates" /></div>
            <select className="input sm:w-auto" value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active</option><option value="draft">Drafts</option><option value="published">Published</option><option value="archived">Archived</option><option value="all">All</option></select>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="card border-dashed py-10 text-center"><FileText className="mx-auto size-7 text-muted-foreground" /><p className="mt-3 font-medium">{templates.length === 0 ? "No templates yet" : "No templates match this filter"}</p><p className="mt-1 text-xs text-muted-foreground">{templates.length === 0 ? "Create a reusable marketing or operational message." : "Try a different search or status."}</p>{templates.length === 0 && !editorOpen && <button type="button" className="btn-primary mt-4" onClick={openNew}><Plus className="size-4" /> Create template</button>}</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{filtered.map((template) => {
            const category = categoryFor(template.category);
            const ChannelIcon = category.channel === "sms" ? MessageSquareText : category.channel === "email" ? Mail : FileText;
            return (
              <article key={template.id} className={`card flex min-h-60 flex-col ${template.status === "archived" ? "opacity-65" : ""}`}>
                <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><ChannelIcon className="size-4" /></span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><h3 className="truncate font-semibold">{template.name}</h3><span className="badge shrink-0">{template.status}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{category.label} · v{template.version}</p></div></div>
                {category.channel === "email" && <p className="mt-4 line-clamp-2 text-xs font-medium">{template.subject || "No subject"}</p>}
                <p className="mt-2 line-clamp-4 flex-1 text-xs leading-5 text-muted-foreground">{stripMarkup(template.body) || "Empty content"}</p>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                  {template.status === "draft" && <button type="button" className="btn-secondary btn-sm" onClick={() => openEdit(template)}><Pencil className="size-3.5" /> Edit</button>}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => duplicate(template)}><CopyPlus className="size-3.5" /> Use as new draft</button>
                  {template.status === "draft" && (
                    <ConfirmActionDialog
                      tone="primary"
                      title={`Publish “${template.name}”?`}
                      description="Publishing makes this version immutable. Future changes should start from a new draft so campaign history remains auditable."
                      confirmLabel="Publish template"
                      onConfirm={async () => { await publishMarketingTemplate(template.id); setMessage(`“${template.name}” published.`); router.refresh(); }}
                      trigger={<button type="button" className="btn-primary btn-sm"><Send className="size-3.5" /> Publish</button>}
                    />
                  )}
                  {template.status !== "archived" && (
                    <ConfirmActionDialog
                      title={`Archive “${template.name}”?`}
                      description="The template will remain in history but will no longer be available for new governed work."
                      confirmLabel="Archive template"
                      onConfirm={async () => { await archiveMarketingTemplate(template.id); if (draft.id === template.id) closeEditor(); router.refresh(); }}
                      trigger={<button type="button" className="btn-danger btn-sm"><Archive className="size-3.5" /> Archive</button>}
                    />
                  )}
                </div>
                {template.status === "published" && <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground"><CheckCircle2 className="size-3.5 text-emerald-500" /> Published content is immutable.</p>}
              </article>
            );
          })}</div>
        )}
      </section>
    </div>
  );
}
