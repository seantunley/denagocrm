import { requireOwner } from "@/lib/auth";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { Button } from "@/components/ui/button";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { saveEnabledModules } from "@/app/actions/modules";

export const dynamic = "force-dynamic";

export default async function ModulesSettingsPage() {
  await requireOwner();
  const enabled = await getEnabledModuleIds();

  return (
    <SettingsWorkspace
      current="modules"
      title="Modules"
      description="Turn feature packs on or off for this workspace. Core CRM is always on; disabling a pack hides its navigation and tools. Nothing is deleted — re-enable any time."
      groups={SETTINGS_NAV_GROUPS}
    >
      <form action={saveEnabledModules} className="card max-w-2xl space-y-4 p-5">
        <div className="divide-y divide-border/60">
          {MODULE_REGISTRY.map((m) => {
            const on = enabled.has(m.id);
            return (
              <label
                key={m.id}
                className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <input
                  type="checkbox"
                  name="modules"
                  value={m.id}
                  defaultChecked={on || Boolean(m.mandatory)}
                  disabled={Boolean(m.mandatory)}
                  className="mt-0.5 size-4"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {m.label}
                    {m.mandatory && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Always on
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{m.description}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-[11px] text-muted-foreground">
            Changes apply across the app immediately.
          </p>
          <Button type="submit">Save modules</Button>
        </div>
      </form>
    </SettingsWorkspace>
  );
}
