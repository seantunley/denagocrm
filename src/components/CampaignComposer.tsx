"use client";

import { useActionState, useState } from "react";
import { sendCampaign, sendCampaignTest, type CampaignState } from "@/app/actions/campaigns";

type Audience = { value: string; label: string };
type Template = { id: string; subject: string; body: string };

export default function CampaignComposer({
  audiences,
  templates,
  smtpConfigured,
  smsConfigured,
}: {
  audiences: Audience[];
  templates: Template[];
  smtpConfigured: boolean;
  smsConfigured: boolean;
}) {
  const [channel, setChannel] = useState(smtpConfigured ? "email" : "sms");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<CampaignState | null>(null);
  const [state, formAction, pending] = useActionState(sendCampaign, undefined);

  async function runTest() {
    const fd = new FormData();
    fd.set("channel", channel);
    fd.set("subject", subject);
    fd.set("body", body);
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
      <div>
        <label className="label">Campaign name *</label>
        <input name="name" className="input" required placeholder="e.g. Winter service special" />
      </div>

      <div className="flex gap-4">
        <label className={`flex items-center gap-2 text-sm ${!smtpConfigured ? "opacity-40" : ""}`}>
          <input
            type="radio"
            name="channel"
            value="email"
            checked={channel === "email"}
            disabled={!smtpConfigured}
            onChange={() => setChannel("email")}
          />
          Email
        </label>
        <label className={`flex items-center gap-2 text-sm ${!smsConfigured ? "opacity-40" : ""}`}>
          <input
            type="radio"
            name="channel"
            value="sms"
            checked={channel === "sms"}
            disabled={!smsConfigured}
            onChange={() => setChannel("sms")}
          />
          SMS
        </label>
      </div>

      <div>
        <label className="label">Audience *</label>
        <select name="audience" className="input" defaultValue="all">
          {audiences.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {channel === "email" && (
        <>
          {templates.length > 0 && (
            <div>
              <label className="label">Start from template</label>
              <select
                className="input"
                defaultValue=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t) {
                    setSubject(t.subject);
                    setBody(t.body);
                  }
                }}
              >
                <option value="">— none —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.subject || "(untitled)"}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label">Subject *</label>
            <input
              name="subject"
              className="input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        </>
      )}

      <div>
        <label className="label">Message *</label>
        <textarea
          name="body"
          className="input"
          rows={7}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hi {{first_name}}, ..."
        />
        <p className="text-xs text-slate-500 mt-1">
          Use <code>{"{{first_name}}"}</code> or <code>{"{{name}}"}</code> to personalise. Only
          opted-in customers are messaged. Max 250 per send.
        </p>
      </div>

      <div className="flex items-end gap-2 border-t border-slate-800 pt-3">
        <div className="flex-1">
          <label className="label">Send a test to</label>
          <input
            className="input"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={channel === "email" ? "you@email.com" : "0821234567"}
          />
        </div>
        <button type="button" onClick={runTest} className="btn-secondary">
          Send test
        </button>
      </div>
      {testMsg?.ok && <p className="text-sm text-emerald-400">{testMsg.ok}</p>}
      {testMsg?.error && <p className="text-sm text-red-400">{testMsg.error}</p>}

      <div className="flex items-center gap-3 border-t border-slate-800 pt-3">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Sending…" : "Send campaign"}
        </button>
        {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
        {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      </div>
    </form>
  );
}
