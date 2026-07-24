import { createCampaignDraft } from "@/app/actions/marketingCampaignDrafts";

export default function NewMarketingCampaignPage() {
  return (
    <form action={createCampaignDraft} className="mx-auto max-w-xl space-y-5">
      <div>
        <p className="text-sm font-medium text-primary">Marketing</p>
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">Create campaign draft</h1>
        <p className="mt-1 text-sm text-muted-foreground">The campaign is saved immediately. Nothing is sent from this screen.</p>
      </div>
      <section className="card space-y-4">
        <label className="space-y-1 block"><span className="label">Campaign name</span><input name="name" className="input" placeholder="e.g. Spring Rover XL launch" autoFocus /></label>
        <label className="space-y-1 block"><span className="label">Channel</span><select name="channel" className="input" defaultValue="email"><option value="email">Email</option><option value="sms">SMS</option></select></label>
        <label className="space-y-1 block"><span className="label">Objective</span><input name="objective" className="input" placeholder="What should this campaign achieve?" /></label>
        <button className="btn-primary w-full">Create and open editor</button>
      </section>
    </form>
  );
}
