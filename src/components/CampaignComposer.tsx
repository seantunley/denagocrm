"use client";

import { useActionState, useState } from "react";
import RichTextEditor from "@/components/RichTextEditor";
import {
  sendCampaign,
  sendCampaignTest,
  previewAudience,
  uploadCampaignImage,
  saveSegment,
  type CampaignState,
} from "@/app/actions/campaigns";

type Tag = { id: string; name: string };
type Template = { id: string; subject: string; body: string };
type Segment = { id: string; name: string; criteria: string };

const PROVINCES = [
  "Western Cape", "Eastern Cape", "Northern Cape", "Gauteng", "KwaZulu-Natal",
  "Free State", "North West", "Limpopo", "Mpumalanga",
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
const EMPTY: Criteria = { source: "", tagId: "", province: "", hasVehicle: false, serviceDue: false, wonOnly: false };

export default function CampaignComposer({
  tags,
  templates,
  segments,
  smtpConfigured,
  smsConfigured,
}: {
  tags: Tag[];
  templates: Template[];
  segments: Segment[];
  smtpConfigured: boolean;
  smsConfigured: boolean;
}) {
  const [channel, setChannel] = useState(smtpConfigured ? "email" : "sms");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [cr, setCr] = useState<Criteria>(EMPTY);
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<CampaignState | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [segName, setSegName] = useState("");
  const [state, formAction, pending] = useActionState(sendCampaign, undefined);

  function crFields() {
    const fd = new FormData();
    fd.set("channel", channel);
    fd.set("f_source", cr.source);
    fd.set("f_tagId", cr.tagId);
    fd.set("f_province", cr.province);
    if (cr.hasVehicle) fd.set("f_hasVehicle", "on");
    if (cr.serviceDue) fd.set("f_serviceDue", "on");
    if (cr.wonOnly) fd.set("f_wonOnly", "on");
    return fd;
  }

  async function preview() {
    setCounting(true);
    const { count } = await previewAudience(crFields());
    setCount(count);
    setCounting(false);
  }

  async function runTest() {
    const fd = new FormData();
    fd.set("channel", channel);
    fd.set("subject", subject);
    fd.set("htmlBody", html);
    fd.set("body", smsBody);
    fd.set("testTo", testTo);
    setTestMsg(await sendCampaignTest(undefined, fd));
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!confirm("Send this campaign to everyone in the selected audience?")) e.preventDefault();
      }}
      className="card space-y-4"
    >
      {/* hidden fields carrying editor + criteria into the action */}
      <input type="hidden" name="htmlBody" value={html} />
      <input type="hidden" name="f_source" value={cr.source} />
      <input type="hidden" name="f_tagId" value={cr.tagId} />
      <input type="hidden" name="f_province" value={cr.province} />
      {cr.hasVehicle && <input type="hidden" name="f_hasVehicle" value="on" />}
      {cr.serviceDue && <input type="hidden" name="f_serviceDue" value="on" />}
      {cr.wonOnly && <input type="hidden" name="f_wonOnly" value="on" />}

      <div>
        <label className="label">Campaign name *</label>
        <input name="name" className="input" required placeholder="e.g. Winter service special" />
      </div>

      <div className="flex gap-4">
        <label className={`flex items-center gap-2 text-sm ${!smtpConfigured ? "opacity-40" : ""}`}>
          <input type="radio" name="channel" value="email" checked={channel === "email"} disabled={!smtpConfigured} onChange={() => setChannel("email")} />
          Email
        </label>
        <label className={`flex items-center gap-2 text-sm ${!smsConfigured ? "opacity-40" : ""}`}>
          <input type="radio" name="channel" value="sms" checked={channel === "sms"} disabled={!smsConfigured} onChange={() => setChannel("sms")} />
          SMS
        </label>
      </div>

      {/* Audience builder */}
      <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Audience</p>
          {segments.length > 0 && (
            <select
              className="input btn-sm w-auto text-xs"
              defaultValue=""
              onChange={(e) => {
                const s = segments.find((x) => x.id === e.target.value);
                if (s) setCr({ ...EMPTY, ...JSON.parse(s.criteria) });
              }}
            >
              <option value="">Load saved…</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select className="input" value={cr.source} onChange={(e) => setCr({ ...cr, source: e.target.value })}>
            <option value="">Any source</option>
            {SOURCES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
          <select className="input" value={cr.tagId} onChange={(e) => setCr({ ...cr, tagId: e.target.value })}>
            <option value="">Any tag</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="input" value={cr.province} onChange={(e) => setCr({ ...cr, province: e.target.value })}>
            <option value="">Any province</option>
            {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="flex flex-col gap-1 justify-center text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cr.hasVehicle} onChange={(e) => setCr({ ...cr, hasVehicle: e.target.checked })} /> Owns a cart
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cr.serviceDue} onChange={(e) => setCr({ ...cr, serviceDue: e.target.checked })} /> Service due
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cr.wonOnly} onChange={(e) => setCr({ ...cr, wonOnly: e.target.checked })} /> Bought before
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={preview} className="btn-secondary btn-sm">
            {counting ? "Counting…" : "Preview count"}
          </button>
          {count != null && <span className="text-sm text-emerald-400">{count} recipient{count === 1 ? "" : "s"}</span>}
          <span className="flex-1" />
          <input className="input btn-sm w-32 text-xs" placeholder="Segment name" value={segName} onChange={(e) => setSegName(e.target.value)} />
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={async () => {
              if (!segName.trim()) return;
              const fd = crFields();
              fd.set("name", segName.trim());
              await saveSegment(fd);
              setSegName("");
            }}
          >
            Save segment
          </button>
        </div>
      </div>

      {channel === "email" ? (
        <>
          {templates.length > 0 && (
            <div>
              <label className="label">Start from template</label>
              <select
                className="input"
                defaultValue=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t) { setSubject(t.subject); setHtml(t.body); }
                }}
              >
                <option value="">— none —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.subject || "(untitled)"}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label">Subject *</label>
            <input name="subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="label">Email</label>
            <RichTextEditor value={html} onChange={setHtml} onImageUpload={(f) => uploadCampaignImage(toFd(f))} placeholder="Hi {{first_name}}, …" />
            <p className="text-xs text-slate-500 mt-1">
              Use <code>{"{{first_name}}"}</code> to personalise. An unsubscribe link and open/click
              tracking are added automatically.
            </p>
          </div>
        </>
      ) : (
        <div>
          <label className="label">Message</label>
          <textarea name="body" className="input" rows={5} value={smsBody} onChange={(e) => setSmsBody(e.target.value)} placeholder="Hi {{first_name}}, …" />
        </div>
      )}

      <div className="flex items-end gap-2 border-t border-slate-800 pt-3">
        <div className="flex-1">
          <label className="label">Send a test to</label>
          <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={channel === "email" ? "you@email.com" : "0821234567"} />
        </div>
        <button type="button" onClick={runTest} className="btn-secondary">Send test</button>
      </div>
      {testMsg?.ok && <p className="text-sm text-emerald-400">{testMsg.ok}</p>}
      {testMsg?.error && <p className="text-sm text-red-400">{testMsg.error}</p>}

      <div className="flex items-center gap-3 border-t border-slate-800 pt-3">
        <button className="btn-primary" disabled={pending}>{pending ? "Starting…" : "Send campaign"}</button>
        {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
        {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      </div>
    </form>
  );
}

function toFd(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}
