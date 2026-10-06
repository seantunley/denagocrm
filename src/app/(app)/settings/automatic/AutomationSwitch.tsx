"use client";

import { useActionState, useState } from "react";
import { saveAutomationSwitch } from "@/app/actions/automationSettings";

/** One automation's on/off switch. Saves when it is flipped. */
export function AutomationSwitch({ settingKey, initial, label }: { settingKey: string; initial: boolean; label: string }) {
  const [state, action, saving] = useActionState(saveAutomationSwitch, {});
  const [on, setOn] = useState(initial);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="key" value={settingKey} />
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="on"
          checked={on}
          disabled={saving}
          aria-label={`${label}: ${on ? "on" : "off"}`}
          onChange={(event) => {
            setOn(event.target.checked);
            event.currentTarget.form?.requestSubmit();
          }}
          className="size-4 accent-orange-600"
        />
        <span className={on ? "font-medium text-emerald-500" : "text-muted-foreground"}>{on ? "On" : "Off"}</span>
      </label>
      {state?.error && <span role="alert" className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}
