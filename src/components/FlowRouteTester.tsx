"use client";

import { useMemo, useState } from "react";
import { Route, Search } from "lucide-react";
import { routeMatches, type FlowEntryContext } from "@/lib/flowRouteRule";

type RouteRow = {
  id: string;
  channel: string;
  kind: string;
  pattern: string;
  priority: number;
  enabled: boolean;
  flowName: string;
};

const labels: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" };

export default function FlowRouteTester({ routes }: { routes: RouteRow[] }) {
  const [channel, setChannel] = useState("whatsapp");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"keyword" | "referral" | "ad">("keyword");

  const result = useMemo(() => {
    const entry: FlowEntryContext = kind === "keyword" ? { text: value } : kind === "referral" ? { referralRef: value } : { adId: value };
    return routes
      .filter((route) => route.enabled && route.channel === channel)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .find((route) => routeMatches(route, entry)) ?? null;
  }, [channel, kind, routes, value]);

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card"><Route className="size-4 text-primary" /></span>
        <div><h3 className="text-sm font-semibold">Test current routing</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Preview which enabled rule wins without starting a customer conversation.</p></div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[9rem_10rem_minmax(0,1fr)]">
        <div><label className="label">Channel</label><select className="input" value={channel} onChange={(event) => setChannel(event.target.value)}>{Object.keys(labels).map((key) => <option key={key} value={key}>{labels[key]}</option>)}</select></div>
        <div><label className="label">Signal</label><select className="input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="keyword">Keyword</option><option value="referral">Referral</option><option value="ad">Ad ID</option></select></div>
        <div><label className="label">Incoming value</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input className="input pl-9" value={value} onChange={(event) => setValue(event.target.value)} placeholder={kind === "keyword" ? "I need warranty help" : kind === "referral" ? "campaign-ref" : "123456789"} /></div></div>
      </div>
      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${value && result ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-border bg-card text-muted-foreground"}`}>
        {!value ? "Enter a value to preview routing." : result ? <><b>{result.flowName}</b> wins via {result.kind} “{result.pattern}” at priority {result.priority}.</> : `No enabled ${labels[channel] ?? channel} route matches. The channel default will be used.`}
      </div>
    </div>
  );
}
