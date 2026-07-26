import { createCampaignDraft } from "@/app/actions/marketingCampaignDrafts";
import { PageHeader } from "@/components/page-header";

export default function NewMarketingCampaignPage() {
  return (
    <form action={createCampaignDraft} className="mx-auto max-w-xl space-y-5">
      <PageHeader title="Create campaign draft" description="The campaign is saved immediately. Nothing is sent from this screen." />
      <section className="card space-y-4">
        <label className="space-y-1 block"><span className="label">Campaign name</span><input name="name" className="input" placeholder="e.g. Spring Rover XL launch" autoFocus /></label>
        <label className="space-y-1 block"><span className="label">Channel</span><select name="channel" className="input" defaultValue="email"><option value="email">Email</option><option value="sms">SMS</option></select></label>
        <label className="space-y-1 block"><span className="label">Objective</span><input name="objective" className="input" placeholder="What should this campaign achieve?" /></label>
        <button className="btn-primary w-full">Create and open editor</button>
      </section>
    </form>
  );
}
