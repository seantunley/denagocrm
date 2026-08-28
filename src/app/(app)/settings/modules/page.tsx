import { requireOwner } from "@/lib/auth";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { Button } from "@/components/ui/button";
import { getEnabledModuleIds, grantedModuleIdsForRequest } from "@/lib/modules/enabled";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { saveEnabledModules } from "@/app/actions/modules";

export const dynamic = "force-dynamic";

export default async function ModulesSettingsPage() {
  await requireOwner();
  /*
   * BOTH LAYERS, because a checkbox cannot honestly show only one.
   *
   * `enabled` is what is effective; `granted` is what this workspace MAY use.
   * Effective = granted MINUS locally disabled, and this screen only writes the
   * disable list. So a module that was never granted rendered as an unchecked
   * box was a control that could not work: ticking it saved correctly, the
   * module stayed off, and the box came back unticked — indistinguishable from
   * the save being broken. That is exactly how it was read on 2026-08-28.
   *
   * Now an ungranted pack says so and cannot be ticked at all.
   */
  const [enabled, granted] = await Promise.all([
    getEnabledModuleIds(),
    grantedModuleIdsForRequest(),
  ]);
  const ungranted = MODULE_REGISTRY.filter((m) => !m.mandatory && !granted.has(m.id));

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
            const available = Boolean(m.mandatory) || granted.has(m.id);
            return (
              <label
                key={m.id}
                className={`flex items-start gap-3 py-3 first:pt-0 last:pb-0 ${available ? "" : "opacity-60"}`}
              >
                <input
                  type="checkbox"
                  name="modules"
                  value={m.id}
                  defaultChecked={on || Boolean(m.mandatory)}
                  // An ungranted pack is disabled, not merely unchecked. A
                  // disabled input also posts nothing, so the save cannot even
                  // appear to ask for something the grant forbids.
                  disabled={Boolean(m.mandatory) || !available}
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
                    {!available && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                        Not in your plan
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{m.description}</span>
                  {!available && (
                    <span className="mt-1 block text-xs text-amber-400/90">
                      This pack is not enabled for your workspace, so it cannot be switched on
                      here. Ask your platform administrator to add it.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-[11px] text-muted-foreground">
            Changes apply across the app immediately.
            {ungranted.length > 0 && (
              <>
                {" "}
                {ungranted.length} pack{ungranted.length === 1 ? " is" : "s are"} not included in
                your plan and cannot be switched on here.
              </>
            )}
          </p>
          <Button type="submit">Save modules</Button>
        </div>
      </form>
    </SettingsWorkspace>
  );
}
