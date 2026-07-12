import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import MarketingJourneyForm from "@/components/MarketingJourneyForm";
import { createMarketingJourney } from "@/app/actions/marketingJourneys";

export default async function NewJourneyPage() {
  await requireOwner();
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
          <Link href="/automations/journeys" className="hover:text-orange-400">Marketing journeys</Link>
          <span>/</span><span>New</span>
        </div>
        <h1 className="text-2xl font-bold">New marketing journey</h1>
        <p className="text-sm text-slate-400 mt-1">Create a draft, validate it, then publish an immutable version.</p>
      </div>
      <div className="card">
        <MarketingJourneyForm action={createMarketingJourney} submitLabel="Create draft" />
      </div>
    </div>
  );
}
