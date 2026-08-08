import { ShieldCheck, Clock } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { readSigningSecuritySettings } from "@/app/actions/signingSecuritySettings";
import { timestampAuthorityUrl, timestampingEnabled } from "@/lib/signing/timestamp";
import { SigningSecurityForm } from "./SigningSecurityForm";

export const dynamic = "force-dynamic";

export default async function SigningSecurityPage() {
  await requireOwner();
  const settings = await readSigningSecuritySettings();
  const tsaOn = timestampingEnabled();
  const tsaUrl = timestampAuthorityUrl();

  return (
    <SettingsWorkspace
      groups={SETTINGS_NAV_GROUPS}
      current="signing-security"
      title="Signing security"
      description="How much a signer has to prove, and what independent evidence is kept."
    >
      <div className="space-y-6">
        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-4 text-emerald-500" />
            Verifying the signer
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Without a check, whoever holds the link can sign — a forwarded email, a shared sales
            inbox or a mail-scanning proxy is enough. A one-time code moves that to whoever controls
            the email address or mobile number you already have on file for the customer.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Worth the extra step on a contract; needless friction on a delivery note. Whoever
            prepares a document can always override this for that document.
          </p>
          <SigningSecurityForm initial={settings} />
        </section>

        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Clock className="size-4 text-sky-500" />
            Independent proof of when
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Our own records show that nobody altered a signed document. They cannot prove to someone
            else <em>when</em> it was signed, because we produce and store all of them. A timestamp
            authority is an independent third party that attests to the moment — which is what turns
            “our records say” into something the other side cannot simply disbelieve.
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1 font-medium">
                {tsaOn ? (
                  <span className="text-emerald-500">On — every completed document is stamped</span>
                ) : (
                  <span className="text-amber-500">Off — set SIGNING_TSA_ENABLED=true to switch on</span>
                )}
              </dd>
            </div>
            <div className="rounded-xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">Authority</dt>
              <dd className="mt-1 break-all font-mono text-sm">{tsaUrl}</dd>
            </div>
          </dl>
          <p className="mt-3 max-w-2xl text-xs text-muted-foreground">
            Only a hash is ever sent — never the document, the signer or the amount. The authority
            learns that something was stamped and nothing more. It is a free public service; change
            it with <code className="font-mono">SIGNING_TSA_URL</code>. If it is unreachable the
            document still completes and is recorded as not stamped, because losing a signed contract
            to someone else’s outage would be the worse failure.
          </p>
        </section>
      </div>
    </SettingsWorkspace>
  );
}
