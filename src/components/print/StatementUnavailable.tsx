import PrintActions from "@/components/PrintActions";

/** Shown instead of a statement the viewer could only see part of — a partial statement states the wrong balance. */
export default function StatementUnavailable({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <>
      <PrintActions backHref={backHref} backLabel={backLabel} />
      <div className="mx-auto mt-10 max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-6 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">This statement can&apos;t be produced for you</p>
        <p className="mt-2">
          This account has invoices you don&apos;t have access to, so a statement printed from here would show the wrong
          balance. Ask someone who can see all quotes to print it.
        </p>
      </div>
    </>
  );
}
