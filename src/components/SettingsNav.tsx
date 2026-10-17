"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsDestination, type SettingsGroup } from "@/lib/settings-navigation";
import { linkOnPhone } from "@/lib/phoneScope";

export default function SettingsNav({ groups, current }: { groups: SettingsGroup[]; current: string }) {
  const router = useRouter();
  const currentItem = groups.flatMap((group) => group.items).find((item) => item.key === current);
  // On a phone, only the sections the phone app keeps — the person's own account (lib/phoneScope.ts).
  const phoneGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => linkOnPhone(settingsDestination(item))) }))
    .filter((group) => group.items.length > 0);
  const picker = (id: string, shown: SettingsGroup[], className: string) => (
    <div className={cn("relative", className)}>
      <label htmlFor={id} className="label">Settings section</label>
      <select
        id={id}
        value={currentItem ? settingsDestination(currentItem) : "/settings"}
        onChange={(event) => router.push(event.target.value)}
        className="input h-11 appearance-none pr-10"
      >
        {shown.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.items.map((item) => <option key={item.key} value={settingsDestination(item)}>{item.label}</option>)}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute bottom-3.5 right-3 size-4 text-muted-foreground" />
    </div>
  );

  return (
    <aside className="shrink-0 lg:w-52">
      {picker("settings-section-phone", phoneGroups, "md:hidden")}
      {picker("settings-section", groups, "hidden md:block lg:hidden")}

      <nav className="hidden space-y-4 lg:block" aria-label="Settings sections">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {group.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <Link
                  key={item.key}
                  href={settingsDestination(item)}
                  aria-current={current === item.key ? "page" : undefined}
                  className={cn(
                    "whitespace-nowrap rounded-md px-2 py-[6px] text-[13px] font-medium transition-colors",
                    current === item.key
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
