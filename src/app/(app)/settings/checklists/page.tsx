import { SettingsSection, SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { getUserPermissionList, requirePermission } from "@/lib/permissions";
import { usableHosts } from "@/lib/checklists/hosts";
import { templatesForHost, type ChecklistTemplateRow } from "@/lib/checklists/store";
import {
  deleteChecklistTemplate,
  saveChecklistTemplate,
} from "@/app/actions/checklistTemplates";
import TemplateEditor, {
  type EditorHost,
  type EditorTemplate,
} from "@/components/checklists/TemplateEditor";

export const dynamic = "force-dynamic";

/**
 * Where guided checklists are configured.
 *
 * ── THE GATE IS THE ACTION'S GATE ───────────────────────────────────────────
 *
 * `document_templates.manage`, which is the key `checklistTemplates.ts` enforces
 * on every write — read that file's header for why this key and not a per-module
 * one. It is stated here so the page cannot be OPENED by somebody every button on
 * it would refuse: a screen that renders a form the action then rejects is a bug
 * report, and one that hides a form the action would have allowed is worse,
 * because the person entitled to use it never learns it exists.
 *
 * (The action holds the key in a private `CONFIGURE_CHECKLISTS` constant. Two
 * copies of a permission string is exactly the drift this codebase keeps
 * removing; exporting it and importing it here is the one-line fix, and it
 * belongs to that file.)
 *
 * ── AND THE HOST GATE, WHICH IS WHY THE LIST OF SITUATIONS IS FILTERED ──────
 *
 * `usableHosts` — the same function the action's second gate uses. A workspace
 * with the automotive pack off has no workshop check-in to configure for, and
 * somebody without `deliveries.manage` should not be authoring the questions on a
 * handover they may not perform. Offering a host here that the save would refuse
 * would teach somebody the feature is broken.
 */
export default async function ChecklistSettingsPage() {
  const user = await requirePermission("document_templates.manage");
  const [permissions, modules] = await Promise.all([
    getUserPermissionList(user),
    getEnabledModuleIds(),
  ]);
  const hosts = usableHosts({
    permissions: new Set<string>(permissions),
    modules: new Set<string>(modules),
  });

  /*
   * Inactive lists INCLUDED, and this is the only caller that should ask for
   * them. A list is deactivated so it stops being offered on a record; it must
   * still be visible to the person who deactivated it, or switching it back on
   * is impossible.
   */
  const groups = await Promise.all(
    hosts.map(async (host) => ({
      host,
      templates: await templatesForHost(host.id, true),
    })),
  );

  const options: EditorHost[] = hosts.map((host) => ({
    id: host.id,
    label: host.label,
    description: host.description,
  }));

  return (
    <SettingsWorkspace
      current="checklists"
      title="Checklists"
      description="Guided lists somebody works through on a phone, one step per screen, with a photograph against each. Configure a list once here and it is offered on every record of that kind. Inactive lists stop being offered but keep everything already captured against them."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        {options.length === 0 && (
          <SettingsSection title="Nothing to configure" description="No situations are available to you.">
            <p className="text-xs text-muted-foreground">
              A checklist is configured for a situation — a delivery handover, a workshop check-in.
              None of those are available in this workspace, either because the feature pack is
              switched off or because you do not hold the permission the record itself requires.
            </p>
          </SettingsSection>
        )}

        {groups.map(({ host, templates }) => (
          <SettingsSection
            key={host.id}
            title={host.label}
            description={`${host.description} · ${templates.length} list${templates.length === 1 ? "" : "s"}`}
          >
            <div className="space-y-6">
              {templates.length > 0 && (
                <div className="divide-y divide-border">
                  {templates.map((template) => (
                    <div key={template.id} className="py-5 first:pt-0 last:pb-0">
                      <p className="mb-3 text-xs font-medium text-muted-foreground">
                        <span className="text-foreground">{template.name}</span>
                        {` · version ${template.version}`}
                        {!template.active && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Inactive
                          </span>
                        )}
                      </p>
                      <TemplateEditor
                        hosts={options}
                        template={toEditorTemplate(template)}
                        save={saveChecklistTemplate}
                        remove={deleteChecklistTemplate}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl border border-dashed border-border p-4">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  New list for {host.label}
                </p>
                <TemplateEditor
                  /*
                   * Keyed on how many lists exist, so creating one resets this
                   * form. Without it React keeps the state of a component at the
                   * same position: the list you just created appears above and
                   * the "new" form still holds everything you typed into it,
                   * which reads as the save having done nothing.
                   */
                  key={`new-${host.id}-${templates.length}`}
                  hosts={options}
                  template={{
                    host: host.id,
                    name: "",
                    description: "",
                    active: true,
                    sortOrder: templates.length,
                    items: [],
                  }}
                  save={saveChecklistTemplate}
                />
              </div>
            </div>
          </SettingsSection>
        ))}
      </div>
    </SettingsWorkspace>
  );
}

/**
 * A stored list, as the editor holds it.
 *
 * The step's `key` is its database id, so a row keeps its identity across a drag
 * without waiting for a save. A step that has never been saved gets a fresh id in
 * the editor — minted in an event handler, never in a render, because a
 * render-time UUID differs between the server and the client and makes the whole
 * subtree a hydration mismatch.
 */
function toEditorTemplate(template: ChecklistTemplateRow): EditorTemplate {
  return {
    id: template.id,
    // Safe to narrow: `templatesForHost` was asked for exactly this host.
    host: template.host as EditorTemplate["host"],
    name: template.name,
    description: template.description ?? "",
    active: template.active,
    sortOrder: template.sortOrder,
    items: [...template.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({
        key: item.id,
        id: item.id,
        label: item.label,
        description: item.description ?? "",
        capture: item.capture as EditorTemplate["items"][number]["capture"],
        required: item.required,
        minPhotos: item.minPhotos,
        maxPhotos: item.maxPhotos,
      })),
  };
}
