"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import RichTextEditor from "@/components/RichTextEditor";
import {
  sendCampaign,
  sendCampaignTest,
  previewAudience,
  uploadCampaignImage,
  type CampaignState,
} from "@/app/actions/campaigns";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { StickyActionArea } from "@/components/responsive-patterns";
import { FeedbackBanner } from "@/components/visual-system";

type Template = { id: string; subject: string; body: string };
type Segment = { id: string; name: string };

export default function CampaignComposer({
  templates,
  segments,
  smtpConfigured,
  smsConfigured,
}: {
  templates: Template[];
  segments: Segment[];
  smtpConfigured: boolean;
  smsConfigured: boolean;
}) {
  const [channel, setChannel] = useState(smtpConfigured ? "email" : "sms");
  const [segmentId, setSegmentId] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<CampaignState | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [state, formAction, pending] = useActionState(sendCampaign, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  // live recipient count whenever audience or channel changes
  useEffect(() => {
    let alive = true;
    const fd = new FormData();
    fd.set("channel", channel);
    fd.set("segmentId", segmentId);
    previewAudience(fd).then((r) => {
      if (alive) setCount(r.count);
    });
    return () => {
      alive = false;
    };
  }, [channel, segmentId]);

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
      ref={formRef}
      action={formAction}
      className="max-w-2xl space-y-5"
    >
      <input type="hidden" name="htmlBody" value={html} />
      <input type="hidden" name="segmentId" value={segmentId} />

      <div className="card space-y-4">
        <div>
          <label className="label">Campaign name</label>
          <input name="name" className="input" required placeholder="e.g. Winter service special" />
        </div>

        <div>
          <label className="label">Channel</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setChannel("email")}
              disabled={!smtpConfigured}
              className={`btn-sm rounded-lg px-4 py-2 ${channel === "email" ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300"} ${!smtpConfigured ? "opacity-40" : ""}`}
            >
              ✉️ Email
            </button>
            <button
              type="button"
              onClick={() => setChannel("sms")}
              disabled={!smsConfigured}
              className={`btn-sm rounded-lg px-4 py-2 ${channel === "sms" ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300"} ${!smsConfigured ? "opacity-40" : ""}`}
            >
              💬 SMS
            </button>
          </div>
          <input type="hidden" name="channel" value={channel} />
        </div>

        <div>
          <label className="label">Audience</label>
          <select className="input" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
            <option value="">All subscribers</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            {count == null ? "…" : `${count} recipient${count === 1 ? "" : "s"}`} · opted-out
            customers are always excluded. Build audiences in the Audiences tab.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="card space-y-4">
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
              <label className="label">Subject</label>
              <input name="subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} required />
            </div>
            <div>
              <label className="label">Email content</label>
              <RichTextEditor value={html} onChange={setHtml} onImageUpload={(f) => uploadCampaignImage(toFd(f))} placeholder="Hi {{first_name}}, …" />
              <p className="text-xs text-slate-500 mt-1">
                Use <code>{"{{first_name}}"}</code> to personalise. Unsubscribe link and open/click
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
      </div>

      {/* Test + send */}
      <div className="card space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label">Send a test to</label>
            <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={channel === "email" ? "you@email.com" : "0821234567"} />
          </div>
          <button type="button" onClick={runTest} className="btn-secondary">Send test</button>
        </div>
        {testMsg?.ok && <FeedbackBanner tone="success" title="Test sent">{testMsg.ok}</FeedbackBanner>}
        {testMsg?.error && <FeedbackBanner tone="danger" title="Test failed">{testMsg.error}</FeedbackBanner>}
        {state?.ok && <FeedbackBanner tone="success" title="Campaign started">{state.ok}</FeedbackBanner>}
        {state?.error && <FeedbackBanner tone="danger" title="Campaign could not start">{state.error}</FeedbackBanner>}
        <StickyActionArea className="border-t border-border pt-3 sm:border-t sm:pt-3">
          <ConfirmActionDialog
            title="Send this campaign?"
            description={`This will send to ${count ?? "all available"} recipient${count === 1 ? "" : "s"}. Opted-out customers remain excluded.`}
            confirmLabel="Start sending"
            onConfirm={() => formRef.current?.requestSubmit()}
            trigger={<button type="button" className="btn-primary w-full sm:w-auto" disabled={pending}><Send className="size-4" />{pending ? "Starting…" : "Send campaign"}</button>}
          />
        </StickyActionArea>
      </div>
    </form>
  );
}

function toFd(file: File) {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}
