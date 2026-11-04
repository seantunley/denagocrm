import Link from "next/link";
import { ArrowLeft, KeyRound } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { requireRoute } from "@/lib/permissions";
import { getSetting } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Surface } from "@/components/visual-system";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { FLOW_CONNECTIONS_KEY, parseConnections } from "@/lib/flowConnections";
import { addConnection, deleteConnection } from "@/app/actions/flowConnections";

export const dynamic = "force-dynamic";

/**
 * Flows → Connections (lib/flowConnections.ts): the secret headers "API request" steps use, kept here — encrypted,
 * locked to one host — instead of in the flow. Owner only; values are write-only and never shown again.
 */
export default async function FlowConnectionsPage() {
  await requireRoute("/bot-builder");
  await requireTenantOwner();
  const connections = parseConnections(await getSetting(FLOW_CONNECTIONS_KEY));

  return (
    <div className="space-y-3">
      <PageHeader
        title="Connections"
        description="API keys and other secret headers for the chatbot's API request steps. Stored encrypted, sent only to the address you give, and never shown again — a step chooses the connection instead of holding the key."
        className="border-b border-border/80 pb-3"
      >
        <Link href="/bot-builder" className="btn-secondary btn-sm min-h-11 sm:min-h-9"><ArrowLeft className="size-4" />Flow library</Link>
      </PageHeader>

      <Surface className="p-4">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4 text-muted-foreground" />{c.name}</p>
                  <p className="text-xs text-muted-foreground">Only sent to <strong className="text-foreground">{c.host}</strong> · {c.headers.map((h) => `${h.name}: ••••••`).join(" · ")}</p>
                </div>
                <ConfirmActionDialog
                  trigger={<button type="button" className="btn-secondary btn-sm text-red-300">Delete</button>}
                  title={`Delete “${c.name}”?`}
                  description="Any API request step using it will fail (and take its “If it fails” route) until you choose another connection."
                  confirmLabel="Delete connection"
                  destructive
                  success="Connection deleted"
                  onConfirm={deleteConnection.bind(null, c.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <Surface className="p-4">
        <h2 className="font-semibold">Add a connection</h2>
        <SaveForm action={addConnection} success="Connection saved" className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="conn-name">Name</label><input id="conn-name" name="name" className="input" required maxLength={60} placeholder="Sage API" /></div>
            <div><label className="label" htmlFor="conn-host">API address</label><input id="conn-host" name="host" className="input" required placeholder="api.sage.com" /><p className="mt-1 text-xs text-muted-foreground">The key is only ever sent to this address.</p></div>
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <div><label className="label" htmlFor={`conn-h${i}`}>Header {i + 1}{i > 0 ? " (optional)" : ""}</label><input id={`conn-h${i}`} name={`header${i}`} className="input" placeholder={i === 0 ? "Authorization" : ""} required={i === 0} maxLength={60} /></div>
              <div><label className="label" htmlFor={`conn-v${i}`}>Value</label><input id={`conn-v${i}`} name={`value${i}`} type="password" autoComplete="off" className="input" placeholder={i === 0 ? "Bearer …" : ""} required={i === 0} /></div>
            </div>
          ))}
          <SaveButton className="btn-primary btn-sm">Save connection</SaveButton>
        </SaveForm>
      </Surface>
    </div>
  );
}
