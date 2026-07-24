"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { createTemplate, deleteTemplate, updateTemplate } from "@/app/actions/emails";
import { EmptyState, SectionHeading, Surface } from "@/components/visual-system";

type Template = { id: string; name: string; subject: string; body: string };

export default function TemplateManager({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const selectedTemplate = editing;
  const showForm = creating || editing;

  function closeEditor() {
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Message templates"
        description="Reusable starting points keep campaign tone and structure consistent."
        action={
          !showForm ? (
            <button
              className="btn-primary"
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
            >
              <Plus className="size-4" />
              New template
            </button>
          ) : undefined
        }
      />

      {showForm && (
        <Surface className="p-5 sm:p-6">
          <SectionHeading
            title={selectedTemplate ? "Edit template" : "Create template"}
            description="Set the default subject and content. You can customise both for each campaign."
            action={
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={closeEditor}
                aria-label="Close template editor"
              >
                <X className="size-4" />
                Close
              </button>
            }
            className="mb-5"
          />
          <form
            action={
              selectedTemplate
                ? updateTemplate.bind(null, selectedTemplate.id)
                : createTemplate
            }
            onSubmit={() => setTimeout(() => {
              closeEditor();
              router.refresh();
            }, 400)}
            className="grid gap-4 lg:grid-cols-2"
          >
            <div>
              <label className="label" htmlFor="template-name">Template name</label>
              <input
                id="template-name"
                name="name"
                className="input"
                required
                defaultValue={selectedTemplate?.name ?? ""}
                placeholder="e.g. Winter promotion"
              />
            </div>
            <div>
              <label className="label" htmlFor="template-subject">Subject</label>
              <input
                id="template-subject"
                name="subject"
                className="input"
                required
                defaultValue={selectedTemplate?.subject ?? ""}
                placeholder="A clear email subject"
              />
            </div>
            <div className="lg:col-span-2">
              <label className="label" htmlFor="template-body">Body</label>
              <textarea
                id="template-body"
                name="body"
                className="input min-h-64 resize-y font-mono text-xs leading-6"
                rows={12}
                required
                defaultValue={selectedTemplate?.body ?? ""}
                placeholder="Plain text or HTML. Use {{first_name}} to personalise."
              />
              <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                Placeholders: <code>{"{{first_name}}"}</code> and <code>{"{{name}}"}</code>.
                Templates are also available to service-reminder emails.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 lg:col-span-2">
              <button className="btn-primary">
                {selectedTemplate ? "Save template" : "Create template"}
              </button>
              <button type="button" className="btn-secondary" onClick={closeEditor}>
                Cancel
              </button>
            </div>
          </form>
        </Surface>
      )}

      {templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No message templates"
          description="Create a reusable email starting point for promotions, events or customer follow-ups."
          action={
            !showForm ? (
              <button
                className="btn-primary"
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                }}
              >
                <Plus className="size-4" />
                Create template
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Surface key={template.id} className="flex min-h-44 flex-col p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{template.name}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {template.subject}
                  </p>
                </div>
              </div>
              <p className="mt-4 line-clamp-3 flex-1 text-xs leading-5 text-muted-foreground/80">
                {template.body.replace(/<[^>]*>/g, " ")}
              </p>
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                <button
                  className="btn-secondary btn-sm flex-1"
                  onClick={() => {
                    setEditing(template);
                    setCreating(false);
                  }}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </button>
                <form
                  action={deleteTemplate.bind(null, template.id)}
                  onSubmit={() => setTimeout(() => router.refresh(), 400)}
                >
                  <button className="btn-danger btn-sm" aria-label={`Delete ${template.name}`}>
                    <Trash2 className="size-3.5" />
                    Delete
                  </button>
                </form>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
