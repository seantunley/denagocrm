"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Filter, Save, ScanSearch, UsersRound } from "lucide-react";
import { previewAudience, saveSegment } from "@/app/actions/campaigns";
import { SectionHeading, StatusPill, Surface } from "@/components/visual-system";

type Tag = { id: string; name: string };

const PROVINCES = [
  "Western Cape",
  "Eastern Cape",
  "Northern Cape",
  "Gauteng",
  "KwaZulu-Natal",
  "Free State",
  "North West",
  "Limpopo",
  "Mpumalanga",
];
const SOURCES = ["manual", "facebook", "instagram", "website", "whatsapp"];

type Criteria = {
  source: string;
  tagId: string;
  province: string;
  hasVehicle: boolean;
  serviceDue: boolean;
  wonOnly: boolean;
};

const EMPTY: Criteria = {
  source: "",
  tagId: "",
  province: "",
  hasVehicle: false,
  serviceDue: false,
  wonOnly: false,
};

export default function SegmentBuilder({ tags }: { tags: Tag[] }) {
  const router = useRouter();
  const [criteria, setCriteria] = useState<Criteria>(EMPTY);
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [saving, setSaving] = useState(false);

  function buildFormData() {
    const formData = new FormData();
    formData.set("channel", "email");
    formData.set("f_source", criteria.source);
    formData.set("f_tagId", criteria.tagId);
    formData.set("f_province", criteria.province);
    if (criteria.hasVehicle) formData.set("f_hasVehicle", "on");
    if (criteria.serviceDue) formData.set("f_serviceDue", "on");
    if (criteria.wonOnly) formData.set("f_wonOnly", "on");
    return formData;
  }

  async function preview() {
    setCounting(true);
    setCount((await previewAudience(buildFormData())).count);
    setCounting(false);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const formData = buildFormData();
    formData.set("name", name.trim());
    await saveSegment(formData);
    setSaving(false);
    setName("");
    setCriteria(EMPTY);
    setCount(null);
    router.refresh();
  }

  return (
    <Surface className="p-5 sm:p-6">
      <SectionHeading
        title={
          <span className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <Filter className="size-4" />
            </span>
            Build an audience
          </span>
        }
        description="Combine customer signals into a reusable, consent-safe campaign audience."
        action={
          count !== null ? (
            <StatusPill tone={count > 0 ? "success" : "warning"}>
              {count} match{count === 1 ? "" : "es"}
            </StatusPill>
          ) : undefined
        }
        className="mb-5"
      />

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="audience-source">Lead source</label>
          <select
            id="audience-source"
            className="input"
            value={criteria.source}
            onChange={(event) => setCriteria({ ...criteria, source: event.target.value })}
          >
            <option value="">Any source</option>
            {SOURCES.map((source) => (
              <option key={source} value={source} className="capitalize">
                {source}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="audience-tag">Customer tag</label>
          <select
            id="audience-tag"
            className="input"
            value={criteria.tagId}
            onChange={(event) => setCriteria({ ...criteria, tagId: event.target.value })}
          >
            <option value="">Any tag</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="audience-province">Province</label>
          <select
            id="audience-province"
            className="input"
            value={criteria.province}
            onChange={(event) => setCriteria({ ...criteria, province: event.target.value })}
          >
            <option value="">Any province</option>
            {PROVINCES.map((province) => (
              <option key={province} value={province}>
                {province}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="mt-5">
        <legend className="label">Lifecycle signals</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <SignalChoice
            label="Owns a cart"
            description="Has a vehicle on record"
            checked={criteria.hasVehicle}
            onChange={(checked) => setCriteria({ ...criteria, hasVehicle: checked })}
          />
          <SignalChoice
            label="Service due"
            description="Needs a service follow-up"
            checked={criteria.serviceDue}
            onChange={(checked) => setCriteria({ ...criteria, serviceDue: checked })}
          />
          <SignalChoice
            label="Bought before"
            description="Has a won opportunity"
            checked={criteria.wonOnly}
            onChange={(checked) => setCriteria({ ...criteria, wonOnly: checked })}
          />
        </div>
      </fieldset>

      <div className="mt-5 grid gap-3 border-t border-border pt-5 lg:grid-cols-[auto_minmax(14rem,1fr)_auto] lg:items-end">
        <button type="button" onClick={preview} className="btn-secondary">
          <ScanSearch className="size-4" />
          {counting ? "Counting…" : "Preview audience"}
        </button>
        <div>
          <label className="label" htmlFor="audience-name">Audience name</label>
          <input
            id="audience-name"
            className="input"
            placeholder="e.g. Gauteng service customers"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving || !name.trim()}
          className="btn-primary"
        >
          <Save className="size-4" />
          {saving ? "Saving…" : "Save audience"}
        </button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
        <UsersRound className="mt-0.5 size-3.5 shrink-0" />
        The preview respects the current contact data. Opted-out customers remain excluded when a
        campaign is sent.
      </p>
    </Surface>
  );
}

function SignalChoice({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
        checked ? "border-primary/40 bg-primary/10" : "border-border bg-muted/20 hover:bg-muted/40"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
