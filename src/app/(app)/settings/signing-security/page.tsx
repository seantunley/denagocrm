import Link from "next/link";
import { ShieldCheck, Clock, BellOff, Stamp } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { readSealCertificate, readSigningSecuritySettings } from "@/app/actions/signingSecuritySettings";
import { getRegionalSettings } from "@/lib/settings";
import { formatDate } from "@/lib/format";
import { SealCertificateForm } from "./SealCertificateForm";
import { readReadyMadeJourneys } from "@/app/actions/automationSettings";
import { timestampAuthorityUrl, timestampingEnabled } from "@/lib/signing/timestamp";
import { SigningSecurityForm } from "./SigningSecurityForm";

export const dynamic = "force-dynamic";

export default async function SigningSecurityPage() {
  await requireTenantOwner();
  const [settings, readyMade, seal, regional] = await Promise.all([
    readSigningSecuritySettings(),
    readReadyMadeJourneys(),
    readSealCertificate(),
    getRegionalSettings(),
  ]);
  const signingReminder = readyMade.rows.find((row) => row.key === "signing-reminders");
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
            <BellOff className="size-4 text-amber-500" />
            Automatic reminders
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Whether the CRM nudges a signer on its own. It is the ready-made journey “Signing reminder” — off
            unless you switch it on: a reminder is a message to your customer that nobody pressed Send on.
            Resend by hand is always available on the request.
          </p>
          <p className="mt-4 text-sm">
            Signing reminder:{" "}
            <span className={signingReminder?.status === "active" ? "font-medium text-emerald-500" : "text-muted-foreground"}>
              {signingReminder?.status === "active" ? "On" : signingReminder?.status ? "Off" : "Deleted"}
            </span>
            {" · "}
            <Link href="/journeys" className="text-primary underline">
              Switch it on or off, or change when it sends, in Journeys
            </Link>
          </p>
        </section>

        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Stamp className="size-4 text-orange-500" />
            The seal on signed documents
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Every completed document is sealed, so anyone can tell if it was changed afterwards. The seal is
            made with a certificate in your company’s name, and the same one is used for every document you
            complete.
          </p>
          {seal.source === "unreadable" ? (
            <div role="alert" className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm">
              <p className="font-semibold text-red-200">Your certificate can’t be opened</p>
              <p className="mt-1 text-muted-foreground">
                A certificate is stored for this workspace but the server cannot read it — usually because the
                server’s encryption key changed. Until that is put right, documents are sealed with a temporary
                certificate that is different every time the server restarts. They are still sealed and still
                valid; they just won’t carry your certificate. Contact support before sending more documents
                for signature.
              </p>
            </div>
          ) : seal.source === "none" ? (
            <div className="mt-4 rounded-xl border border-border p-4 text-sm">
              <p className="font-medium">No certificate yet</p>
              <p className="mt-1 text-muted-foreground">
                One is created automatically the first time a document is completed. You can also create it now.
              </p>
              <SealCertificateForm />
            </div>
          ) : (
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border p-4">
                <dt className="text-xs text-muted-foreground">In use</dt>
                <dd className="mt-1 font-medium text-emerald-500">
                  {seal.source === "server" ? "The server’s certificate" : "Your workspace’s own certificate"}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  {seal.source === "server"
                    ? "Set by whoever runs this server, and used for every workspace on it."
                    : "Kept encrypted with this workspace’s settings. It is never replaced automatically."}
                </dd>
              </div>
              <div className="rounded-xl border border-border p-4">
                <dt className="text-xs text-muted-foreground">Valid</dt>
                <dd className="mt-1 text-sm font-medium">
                  {seal.validFrom ? formatDate(seal.validFrom, regional) : "—"} to {seal.validTo ? formatDate(seal.validTo, regional) : "—"}
                </dd>
              </div>
              <div className="rounded-xl border border-border p-4 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Name on the certificate</dt>
                <dd className="mt-1 break-words text-sm">{seal.subject}</dd>
                <dt className="mt-3 text-xs text-muted-foreground">Fingerprint (SHA-256)</dt>
                <dd className="mt-1 break-all font-mono text-xs">{seal.fingerprint}</dd>
              </div>
            </dl>
          )}
          <p className="mt-3 max-w-2xl text-xs text-muted-foreground">
            A PDF reader will say the signer’s identity can’t be verified. That is expected: this is your own
            certificate, not one bought from a certificate authority. The reader still shows whether the
            document has been altered since it was sealed, and the fingerprint above is how a sealed document
            can be matched to you.
          </p>
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
