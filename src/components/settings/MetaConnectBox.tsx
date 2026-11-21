import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { disconnectMeta, selectMetaPage } from "@/app/actions/metaConnect";
import { metaPlatformApp, pendingMetaPages } from "@/lib/metaConnect";
import { metaPageCredential } from "@/lib/metaPage";

/** What Connect Facebook came back with (?meta=…), in words. */
const NOTICES: Record<string, string> = {
  connected: "Your Facebook Page is connected.",
  pick: "Choose which Page this workspace uses.",
  "no-pages": "That Facebook login manages no Pages. Sign in with a Facebook account that's an admin of your business's Page.",
  "missing-app": "Connect Facebook isn't set up on this CRM yet.",
  denied: "Facebook sign-in was cancelled.",
  invalid: "That sign-in could not be checked — please press Connect Facebook again.",
  "in-use": "That Page (or its Instagram account) is already connected to another workspace, so nothing was connected.",
  failed: "Facebook sign-in could not be completed. Please try again.",
};

/**
 * Settings → Integrations → Meta: CONNECT FACEBOOK (Sean, 2026-11-21). The business signs in to Meta and picks its
 * Page; the Page, its Instagram account and the permissions granted are this workspace's alone (lib/metaConnect.ts).
 * Works from the workspace's own domain.
 */
export default async function MetaConnectBox({ tenantId, notice }: { tenantId: string; notice?: string | null }) {
  const [app, credential, pending] = await Promise.all([metaPlatformApp(), metaPageCredential(tenantId), pendingMetaPages(tenantId)]);
  const message = notice ? NOTICES[notice] : null;
  const connected = credential?.kind === "connected" ? credential : null;
  return (
    <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
      <p className="text-sm font-medium">
        {connected ? `Connected: ${connected.pageName ?? connected.pageId}${connected.igUsername ? ` · Instagram @${connected.igUsername}` : ""}` : "Connect your Facebook Page"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Sign in to Facebook as an admin of your business&apos;s Page and choose it. Messenger, Instagram messages and comments,
        and lead ads from that Page then arrive in this workspace only. You can disconnect at any time.
      </p>
      {message && <p className="mt-2 text-xs text-amber-300">{message}</p>}
      {connected && connected.scopes.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">Permissions granted: {connected.scopes.join(", ")}</p>
      )}

      {pending && pending.length > 0 && !connected && (
        <SaveForm action={selectMetaPage} success="Connected" resetOnSuccess={false} className="mt-3 space-y-2">
          <p className="label">Which Page does this workspace use?</p>
          {pending.map((page, index) => (
            <label key={page.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="pageId" value={page.id} defaultChecked={index === 0} className="accent-primary" />
              {page.name}
              {page.igUsername && <span className="text-xs text-muted-foreground">· Instagram @{page.igUsername}</span>}
            </label>
          ))}
          <SaveButton className="btn-primary btn-sm" pendingLabel="Connecting…">Use this Page</SaveButton>
        </SaveForm>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {app ? (
          <a href="/api/integrations/meta/connect" className="btn-primary btn-sm inline-flex">{connected ? "Reconnect Facebook" : "Connect Facebook"}</a>
        ) : (
          <span className="text-xs text-muted-foreground">Connect Facebook isn&apos;t set up on this CRM yet.</span>
        )}
        {connected && (
          <ConfirmActionDialog
            trigger={<button type="button" className="btn-secondary btn-sm">Disconnect</button>}
            title="Disconnect your Facebook Page?"
            description="Messenger and Instagram messages, comments and lead ads from this Page stop arriving here. Conversations already in the CRM stay."
            confirmLabel="Disconnect"
            onConfirm={disconnectMeta}
            destructive
            success="Disconnected"
          />
        )}
      </div>
    </div>
  );
}
