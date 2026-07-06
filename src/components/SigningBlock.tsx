import { enableSigning, emailSigningLink, revokeSigning } from "@/app/actions/signing";
import CopyButton from "@/components/CopyButton";
import DealerSignPad from "@/components/DealerSignPad";
import { formatDateTime } from "@/lib/format";

const BASE = "https://crm.denagocpt.co.za";

/** "Send for signature" card on quote / job card pages. */
export default function SigningBlock({
  kind,
  id,
  refLabel,
  signToken,
  signedAt,
  signedByName,
  customerEmail,
  customerPhone,
  dealerSignedAt,
  dealerSignedByName,
  hasSavedSignature,
  viewedAt,
  declinedAt,
  declineReason,
  signedPdfHash,
}: {
  kind: "quote" | "jobcard";
  id: string;
  refLabel: string;
  signToken: string | null;
  signedAt: Date | null;
  signedByName: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  dealerSignedAt?: Date | null;
  dealerSignedByName?: string | null;
  hasSavedSignature?: boolean;
  viewedAt?: Date | null;
  declinedAt?: Date | null;
  declineReason?: string | null;
  signedPdfHash?: string | null;
}) {
  if (signedAt) {
    return (
      <div className="card bg-emerald-500/10 border-emerald-500/30">
        <p className="text-sm text-emerald-300">
          ✍ Signed online by <b>{signedByName}</b> on {formatDateTime(signedAt)}. The signed PDF
          is filed in the customer&apos;s documents.
        </p>
        {signedPdfHash && (
          <p className="text-[11px] text-emerald-400/60 mt-1 font-mono">
            Tamper-evidence SHA-256: {signedPdfHash}
          </p>
        )}
      </div>
    );
  }

  const link = signToken ? `${BASE}/sign/${kind}/${signToken}` : null;
  const waDigits = (customerPhone ?? "").replace(/\D/g, "").replace(/^0/, "27");
  const needsDealerSignature = kind === "quote" && !dealerSignedAt;

  return (
    <div className="card">
      <h2 className="font-semibold mb-1">✍ Online signature</h2>
      <p className="text-xs text-slate-400 mb-4">
        {kind === "quote"
          ? "Step 1: Denago signs. Step 2: send the secure link — the customer signs on their phone, which accepts the quote and wins the lead."
          : `The customer opens a secure link, reviews ${refLabel}, and signs on their phone — no printing needed.`}
      </p>

      {declinedAt && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 mb-3">
          <p className="text-xs text-red-300">
            ✗ Declined by the customer on {formatDateTime(declinedAt)}
            {declineReason ? ` — “${declineReason}”` : ""}. The link still works if they change
            their mind, or revoke it below.
          </p>
        </div>
      )}

      {kind === "quote" && dealerSignedAt && (
        <p className="text-xs text-emerald-400 mb-3">
          ✓ Countersigned for Denago by {dealerSignedByName} · {formatDateTime(dealerSignedAt)}
        </p>
      )}

      {viewedAt && (
        <p className="text-xs text-sky-300 mb-3">
          👀 Opened by the customer · first viewed {formatDateTime(viewedAt)}
        </p>
      )}

      {needsDealerSignature ? (
        <DealerSignPad quoteId={id} hasSaved={Boolean(hasSavedSignature)} />
      ) : !link ? (
        <form action={enableSigning.bind(null, kind, id)}>
          <button className="btn-primary">Create signing link</button>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input readOnly value={link} className="input text-xs font-mono" />
            <CopyButton text={link} />
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {customerEmail && (
              <form action={emailSigningLink.bind(null, kind, id)}>
                <button className="btn-secondary btn-sm">✉️ Email link to {customerEmail}</button>
              </form>
            )}
            {waDigits.length >= 10 && (
              <a
                href={`https://wa.me/${waDigits}?text=${encodeURIComponent(
                  `Hi! Here's your Denago Cape Town ${kind === "quote" ? "quote" : "job card"} ${refLabel} to review and sign online: ${link}`
                )}`}
                target="_blank"
                className="btn-secondary btn-sm"
              >
                💬 Send via WhatsApp
              </a>
            )}
            <form action={revokeSigning.bind(null, kind, id)}>
              <button
                className="text-xs text-slate-500 hover:text-red-400 underline cursor-pointer"
                title="The old link stops working immediately; you can create a fresh one after."
              >
                Revoke link
              </button>
            </form>
          </div>
          {kind === "quote" && (
            <p className="text-[11px] text-slate-500">
              🔒 While this link is active the quote is locked for editing — revoke the link to
              make changes, then create a fresh one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
