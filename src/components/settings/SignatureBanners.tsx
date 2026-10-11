"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, MousePointerClick, Pencil, Plus, Send } from "lucide-react";
import { saveMarketingBanner, setMarketingBannerActive } from "@/app/actions/signatureBanners";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { StatusPill } from "@/components/visual-system";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, ResponsiveDialogContent } from "@/components/ui/dialog";
import { BANNER_MAX_WIDTH, bannerDisplaySize, clickRate, type BannerState } from "@/lib/signatureBanners";

export type BannerView = {
  id: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  linkUrl: string;
  altText: string;
  active: boolean;
  /** Form dates (YYYY-MM-DD), empty when not set. */
  startsOn: string;
  endsOn: string;
  /** The same dates as the page words them. */
  startsLabel: string;
  endsLabel: string;
  senderIds: string[];
  teamIds: string[];
  position: "above" | "below";
  onQuoteEmails: boolean;
  sentCount: number;
  clickCount: number;
  state: BannerState;
};
export type ClickView = { id: string; banner: string; who: string; href: string | null; when: string };
type Person = { id: string; name: string };

const STATE: Record<BannerState, { label: string; tone: "success" | "info" | "neutral" | "warning" }> = {
  live: { label: "Live", tone: "success" },
  scheduled: { label: "Scheduled", tone: "info" },
  off: { label: "Off", tone: "neutral" },
  ended: { label: "Ended", tone: "warning" },
};

function when(banner: BannerView): string {
  if (banner.startsLabel && banner.endsLabel) return `${banner.startsLabel} to ${banner.endsLabel}`;
  if (banner.endsLabel) return `Until ${banner.endsLabel}`;
  if (banner.startsLabel) return `From ${banner.startsLabel}, no end date`;
  return "No end date — your standing banner";
}

/**
 * Settings → Signature banners. Each banner is its own row with its own switch:
 * nothing here reaches a customer until its switch is turned on, and switching
 * on asks first, because from that moment every email the team writes carries it.
 */
export default function SignatureBanners({
  banners,
  staff,
  teams,
  clicks,
  showingNowId,
}: {
  banners: BannerView[];
  staff: Person[];
  teams: Person[];
  clicks: ClickView[];
  /** The banner the viewer's own emails carry right now, if any. */
  showingNowId: string | null;
}) {
  const [editing, setEditing] = useState<BannerView | "new" | null>(null);
  const current = banners.filter((banner) => banner.state === "live" || banner.state === "scheduled");
  const rest = banners.filter((banner) => banner.state === "off" || banner.state === "ended");
  const showingNow = banners.find((banner) => banner.id === showingNowId);

  return (
    <div className="space-y-5">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 flex-1 basis-96">
          <p className="text-sm font-semibold text-foreground">
            {showingNow ? `Your emails carry “${showingNow.name}” right now.` : "Your emails carry no banner right now."}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            A banner sits under the signature on emails your team writes to customers. A banner with an end date takes over
            from your standing banner, and hands back on its last day. Customers who opted out of marketing never get one.
          </p>
        </div>
        <button type="button" className="btn-primary btn-sm shrink-0" onClick={() => setEditing("new")}>
          <Plus className="size-4" aria-hidden />
          New banner
        </button>
      </div>

      {banners.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No banners yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Add an image with a link — a special, an event, a new model. It stays switched off until you turn it on.
          </p>
        </div>
      )}

      {current.length > 0 && <BannerList title="Live and scheduled" banners={current} staff={staff} teams={teams} onEdit={setEditing} showingNowId={showingNowId} />}
      {rest.length > 0 && <BannerList title="Off and ended" banners={rest} staff={staff} teams={teams} onEdit={setEditing} showingNowId={showingNowId} />}

      {clicks.length > 0 && (
        <section className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MousePointerClick className="size-4 text-primary" aria-hidden />
            Recent clicks
          </h2>
          <ul className="mt-2 divide-y divide-border/60">
            {clicks.map((click) => (
              <li key={click.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
                {click.href ? <Link href={click.href} className="font-medium text-foreground hover:underline">{click.who}</Link> : <span className="text-muted-foreground">{click.who}</span>}
                <span className="text-muted-foreground">clicked “{click.banner}”</span>
                <span className="ml-auto text-xs text-muted-foreground">{click.when}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Whoever wrote the email gets a notification on the first click. Some mail security systems open every link to check
            it, so an instant click from a company address may not be a person.
          </p>
        </section>
      )}

      <BannerDialog key={editing === "new" ? "new" : editing?.id ?? "closed"} editing={editing} staff={staff} teams={teams} onClose={() => setEditing(null)} />
    </div>
  );
}

function BannerList({
  title, banners, staff, teams, onEdit, showingNowId,
}: { title: string; banners: BannerView[]; staff: Person[]; teams: Person[]; onEdit: (banner: BannerView) => void; showingNowId: string | null }) {
  const names = new Map(staff.map((person) => [person.id, person.name]));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <ul className="space-y-3">
        {banners.map((banner) => {
          const named = [
            ...banner.teamIds.map((id) => `${teamNames.get(id) ?? "A team that was removed"} team`),
            ...banner.senderIds.map((id) => names.get(id) ?? "Someone who has left"),
          ];
          const who = `${named.length === 0 ? "Everyone's emails" : named.join(", ")} · ${banner.position === "above" ? "above the message" : "under the signature"}${banner.onQuoteEmails ? " · also on quote emails" : ""}`;
          return (
            <li key={banner.id} className="card grid gap-4 p-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_auto] lg:items-center">
              {/* The banner itself, on white — the colour of the email it will sit in. */}
              <div className="overflow-hidden rounded-lg bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored public asset at its own size, as the email shows it */}
                <img src={banner.imageUrl} alt={banner.altText || banner.name} width={banner.width} height={banner.height} className="h-auto max-w-full" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{banner.name}</span>
                  <StatusPill tone={STATE[banner.state].tone}>{STATE[banner.state].label}</StatusPill>
                  {banner.id === showingNowId && <StatusPill tone="info">On your emails now</StatusPill>}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><CalendarClock className="size-3.5" aria-hidden />{when(banner)}</p>
                <p className="truncate text-xs text-muted-foreground">Opens <a href={banner.linkUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{banner.linkUrl}</a></p>
                <p className="text-xs text-muted-foreground">{who}</p>
                <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-foreground/80">
                  <span className="flex items-center gap-1.5"><Send className="size-3.5 text-muted-foreground" aria-hidden /><span className="font-semibold tabular-nums">{banner.sentCount}</span> emails sent with it</span>
                  <span className="flex items-center gap-1.5"><MousePointerClick className="size-3.5 text-muted-foreground" aria-hidden /><span className="font-semibold tabular-nums">{banner.clickCount}</span> clicks</span>
                  <span><span className="font-semibold tabular-nums">{clickRate(banner.sentCount, banner.clickCount)}</span> click rate</span>
                </p>
              </div>
              <div className="flex shrink-0 gap-2 lg:flex-col">
                <ActiveSwitch banner={banner} />
                <button type="button" className="btn-secondary btn-sm justify-center" onClick={() => onEdit(banner)}>
                  <Pencil className="size-3.5" aria-hidden />
                  Edit
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActiveSwitch({ banner }: { banner: BannerView }) {
  const [pending, start] = useTransition();
  if (banner.active && banner.state !== "ended") {
    return (
      <button
        type="button"
        disabled={pending}
        className="btn-secondary btn-sm justify-center"
        onClick={() =>
          start(async () => {
            const result = await setMarketingBannerActive(banner.id, false).catch(() => ({ error: "Could not switch it off." }));
            if (result?.error) toast.error(result.error);
            else toast.success("Switched off. Emails stop carrying it now.");
          })
        }
      >
        {pending ? "Switching off…" : "Switch off"}
      </button>
    );
  }
  if (banner.state === "ended") return <span className="self-center text-xs text-muted-foreground">Edit the dates to run it again</span>;
  return (
    <ConfirmActionDialog
      trigger={<button type="button" className="btn-primary btn-sm justify-center">Switch on</button>}
      title={`Switch “${banner.name}” on?`}
      description={`${banner.startsLabel && banner.state !== "live" ? `From ${banner.startsLabel}, emails` : "From now, emails"} your team writes to customers will carry this banner under the signature${banner.endsLabel ? `, until ${banner.endsLabel}` : ""}. Customers who opted out of marketing will not get it.`}
      confirmLabel="Switch on"
      success="Switched on."
      onConfirm={() => setMarketingBannerActive(banner.id, true)}
    />
  );
}

function BannerDialog({ editing, staff, teams, onClose }: { editing: BannerView | "new" | null; staff: Person[]; teams: Person[]; onClose: () => void }) {
  const banner = editing && editing !== "new" ? editing : null;
  const [saving, startSave] = useTransition();
  const [picked, setPicked] = useState<{ url: string; naturalWidth: number; naturalHeight: number } | null>(null);
  const [imageError, setImageError] = useState("");
  const [everyone, setEveryone] = useState(!banner || (banner.senderIds.length === 0 && banner.teamIds.length === 0));
  const fileRef = useRef<HTMLInputElement>(null);

  // The image's own size is read here, from the file, and sent with it: the
  // server works out the shown size from it and refuses anything out of bounds.
  function onFile(file: File | undefined) {
    setImageError("");
    setPicked(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      if (!bannerDisplaySize(probe.naturalWidth, probe.naturalHeight)) {
        setImageError("That image is too small or too tall for a banner. Use a wide image — 1200 × 300 works well.");
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      setPicked({ url, naturalWidth: probe.naturalWidth, naturalHeight: probe.naturalHeight });
    };
    probe.onerror = () => setImageError("That file isn't an image this browser can read.");
    probe.src = url;
  }

  function submit(formData: FormData) {
    if (picked) {
      formData.set("naturalWidth", String(picked.naturalWidth));
      formData.set("naturalHeight", String(picked.naturalHeight));
    }
    if (everyone) {
      formData.delete("senderIds");
      formData.delete("teamIds");
    } else if (formData.getAll("senderIds").length + formData.getAll("teamIds").length === 0) {
      // "Only these" with nobody ticked would quietly mean everyone — the opposite of what was asked.
      return void toast.error("Tick at least one team or person, or choose Everyone's.");
    }
    startSave(async () => {
      const result = await saveMarketingBanner(formData).catch(() => ({ error: "Could not save the banner." }));
      if (result?.error) return void toast.error(result.error);
      toast.success(banner ? "Banner saved." : "Banner added. It is switched off until you turn it on.");
      onClose();
    });
  }

  const shown = picked ? bannerDisplaySize(picked.naturalWidth, picked.naturalHeight) : banner ? { width: banner.width, height: banner.height } : null;
  const previewSrc = picked?.url ?? banner?.imageUrl;

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && !saving && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{banner ? "Edit banner" : "New banner"}</DialogTitle>
          <DialogDescription>
            {banner
              ? "Changes apply to emails sent from now on. Emails already sent keep the banner they went out with."
              : "It is saved switched off. Nothing reaches a customer until you switch it on."}
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="space-y-4">
          {banner && <input type="hidden" name="id" value={banner.id} />}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Name (only your team sees this)</span>
            <input name="name" required maxLength={80} defaultValue={banner?.name ?? ""} placeholder="e.g. November service special" className="input w-full" />
          </label>

          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Banner image</span>
            {previewSrc && shown && (
              <div className="overflow-hidden rounded-lg bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file */}
                <img src={previewSrc} alt="" width={shown.width} height={shown.height} className="h-auto max-w-full" />
              </div>
            )}
            <input ref={fileRef} type="file" name="image" accept="image/png,image/jpeg,image/gif" required={!banner} onChange={(event) => onFile(event.target.files?.[0])} className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:text-foreground" />
            {imageError && <p className="text-xs text-red-400">{imageError}</p>}
            <p className="text-xs text-muted-foreground">
              PNG, JPG or GIF, up to 300 KB. Shown at most {BANNER_MAX_WIDTH}px wide — a 1200 × 300 image stays sharp on phones.
              {shown ? ` This one will be shown at ${shown.width} × ${shown.height}.` : ""}
            </p>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Where a click goes</span>
            <input name="linkUrl" type="url" required maxLength={500} defaultValue={banner?.linkUrl ?? ""} placeholder="https://www.yourcompany.co.za/special" className="input w-full" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Words shown when the image is blocked</span>
            <input name="altText" maxLength={160} defaultValue={banner?.altText ?? ""} placeholder="e.g. Free battery check with every service in November" className="input w-full" />
            <span className="block text-xs text-muted-foreground">Many mail apps hide images until the reader allows them. These words are what they see instead.</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">First day (optional)</span>
              <input name="startsOn" type="date" defaultValue={banner?.startsOn ?? ""} className="input w-full" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Last day (optional)</span>
              <input name="endsOn" type="date" defaultValue={banner?.endsOn ?? ""} className="input w-full" />
            </label>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Leave the last day empty for your standing banner. Give it a last day for a promotion: it takes over while it runs, and your standing banner comes back by itself afterwards.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">Whose emails carry it</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> Everyone&apos;s</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!everyone} onChange={() => setEveryone(false)} /> Only these teams&apos; and people&apos;s</label>
            {!everyone && (
              <div className="space-y-2 pl-6">
                {teams.length > 0 && (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {teams.map((team) => (
                      <label key={team.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="teamIds" value={team.id} defaultChecked={banner?.teamIds.includes(team.id)} />
                        {team.name} <span className="text-xs text-muted-foreground">team</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {staff.map((person) => (
                    <label key={person.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="senderIds" value={person.id} defaultChecked={banner?.senderIds.includes(person.id)} />
                      {person.name}
                    </label>
                  ))}
                </div>
                {teams.length > 0 && <p className="text-xs text-muted-foreground">A team means whoever is in it when the email is sent.</p>}
              </div>
            )}
          </fieldset>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Where it sits</span>
            <select name="position" defaultValue={banner?.position ?? "below"} className="input w-full">
              <option value="below">Under the signature</option>
              <option value="above">At the top of the email, above the message</option>
            </select>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="onQuoteEmails" defaultChecked={banner?.onQuoteEmails ?? false} className="mt-0.5" />
            <span>
              Also on quotes my team emails from the CRM
              <span className="block text-xs text-muted-foreground">Off by default. A quote is a document the customer acts on; signing invitations and automatic messages never carry a banner.</span>
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-secondary btn-sm" disabled={saving} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary btn-sm" disabled={saving || Boolean(imageError)}>{saving ? "Saving…" : banner ? "Save banner" : "Add banner"}</button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
