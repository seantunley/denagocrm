"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pickerGroupLabel, settingsByArea, settingsDestination, type SettingsGroup, type SettingsPickerChoice } from "@/lib/settings-navigation";
import { linkOnPhone } from "@/lib/phoneScope";

/**
 * The settings side menu (stage 2 of the reorganisation): the three area
 * headings, each group folded away except the one you are in, so the list is a
 * dozen lines rather than thirty-six. On a tablet or phone, two short pickers —
 * the group, then the setting in it — instead of one long dropdown.
 */
export default function SettingsNav({ groups, current }: { groups: SettingsGroup[]; current: string }) {
  // On a phone, only the sections the phone app keeps — the person's own account (lib/phoneScope.ts).
  const phoneGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => linkOnPhone(settingsDestination(item))) }))
    .filter((group) => group.items.length > 0);

  return (
    <aside className="shrink-0 lg:w-52">
      <SettingsPicker id="settings-section-phone" groups={phoneGroups} current={current} className="grid md:hidden" />
      <SettingsPicker id="settings-section" groups={groups} current={current} className="hidden md:grid lg:hidden" />

      <nav className="hidden space-y-4 lg:block" aria-label="Settings sections">
        {settingsByArea(groups).map(({ area, groups: inArea }) => (
          <div key={area.key} className={cn(area.key === "admin" && "border-t border-dashed border-border pt-3")}>
            <p className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60">{area.label}</p>
            <div className="space-y-0.5">
              {inArea.map((group) => {
                const here = group.items.some((item) => item.key === current);
                // A one-entry group needs no fold: the entry IS the group.
                if (group.items.length === 1) {
                  const only = group.items[0];
                  return <NavLink key={group.label} href={settingsDestination(only)} active={here} label={only.label} />;
                }
                return (
                  <details key={group.label} open={here} className="group/settings-group">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 py-[6px] text-[13px] font-medium text-foreground/85 transition-colors hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
                      {group.label}
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/settings-group:rotate-90" aria-hidden="true" />
                    </summary>
                    <div className="ml-2 flex flex-col gap-0.5 border-l border-border pl-1.5">
                      {group.items.map((item) => (
                        <NavLink key={item.key} href={settingsDestination(item)} active={current === item.key} label={item.label} />
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function NavLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "block whitespace-nowrap rounded-md px-2 py-[6px] text-[13px] font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

/** Group first, then the setting in it. Choosing a group with one setting goes straight there. */
function SettingsPicker({ id, groups, current, className }: { id: string; groups: SettingsGroup[]; current: string; className: string }) {
  const router = useRouter();
  const currentGroup = groups.find((group) => group.items.some((item) => item.key === current));
  // A group chosen here holds only while you stay on the section you chose it on:
  // moving to another section (/settings?tab=… doesn't remount this) shows THAT
  // section's group again (review of #1076). Derived — no effect resets it.
  const [choice, setChoice] = useState<SettingsPickerChoice>(null);
  const chosen = pickerGroupLabel(groups, current, choice);
  const setChosen = (label: string) => setChoice({ section: current, group: label });
  const group = groups.find((entry) => entry.label === chosen);
  const currentItem = group?.items.find((item) => item.key === current);
  const select = "input h-11 appearance-none pr-10";

  return (
    <div className={cn("max-w-2xl gap-2 sm:grid-cols-2", className)}>
      <div className="relative">
        <label htmlFor={`${id}-group`} className="label">Settings group</label>
        <select
          id={`${id}-group`}
          value={chosen}
          onChange={(event) => {
            const next = groups.find((entry) => entry.label === event.target.value);
            setChosen(event.target.value);
            if (next?.items.length === 1) router.push(settingsDestination(next.items[0]));
          }}
          className={select}
        >
          {!currentGroup && <option value="">Choose a group…</option>}
          {settingsByArea(groups).map(({ area, groups: inArea }) => (
            <optgroup key={area.key} label={area.label}>
              {inArea.map((entry) => <option key={entry.label} value={entry.label}>{entry.label}</option>)}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3 size-4 text-muted-foreground" />
      </div>
      {group && group.items.length > 1 && (
        <div className="relative">
          <label htmlFor={id} className="label">Setting</label>
          <select
            id={id}
            value={currentItem ? settingsDestination(currentItem) : ""}
            onChange={(event) => router.push(event.target.value)}
            className={select}
          >
            {!currentItem && <option value="">Choose a setting…</option>}
            {group.items.map((item) => <option key={item.key} value={settingsDestination(item)}>{item.label}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3 size-4 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
