import type { Metadata } from "next";
import { LegalShell, PrivacyContact } from "../LegalShell";
import { PLATFORM } from "@/lib/platformLegal";
import { metaDeletionStatus } from "@/lib/metaDataDeletion";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Data deletion — ${PLATFORM.name}`, robots: { index: false } };

/**
 * Meta's required data-deletion instructions, plus the status of a request Meta sent us (?code=, the confirmation
 * code our callback returned — lib/metaDataDeletion.ts). The page shows only "completed on <date>", never whose.
 */
export default async function DataDeletionPage({ searchParams }: { searchParams?: Promise<{ code?: string }> }) {
  const code = String((await searchParams)?.code ?? "").trim();
  const status = code ? await metaDeletionStatus(code) : null;
  const name = PLATFORM.name;
  return (
    <LegalShell title="Data deletion">
      {code && (
        <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          {status
            ? <>Request <b>{code}</b> was completed on {new Date(status.at).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" })}.</>
            : <>We couldn&apos;t find a request with the code <b>{code}</b>. Check the code, or contact us below.</>}
        </p>
      )}

      <h2>If you connected Facebook or Instagram to {name}</h2>
      <ol className="ml-5 list-decimal space-y-1">
        <li>On Facebook, open <b>Settings &amp; privacy → Settings → Apps and websites</b>.</li>
        <li>Find <b>{name}</b> and choose <b>Remove</b>.</li>
        <li>Tick the option to delete the information {name} received, and confirm.</li>
      </ol>
      <p>
        Facebook then tells us automatically. We delete the access {name} was given to your Page and Instagram account,
        and disconnect them from every workspace you connected them to. Facebook shows you a confirmation code you can check
        on this page.
      </p>

      <h2>If your business uses {name}</h2>
      <p>
        An owner can disconnect Facebook, Instagram or WhatsApp at any time in <b>Settings → Integrations</b>. The
        access token is deleted straight away and no further messages arrive.
      </p>

      <h2>If you are a customer of a business that uses {name}</h2>
      <p>
        Your messages and details are kept by that business. Ask the business to delete them; they can do so in their
        workspace.
      </p>

      <h2>Anything else</h2>
      <p>
        Write to <PrivacyContact /> with your request.
      </p>
    </LegalShell>
  );
}
