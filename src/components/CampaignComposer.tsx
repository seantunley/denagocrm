"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  FileText,
  Mail,
  MessageSquareText,
  Send,
  Sparkles,
  TestTube2,
  UsersRound,
} from "lucide-react";
import RichTextEditor from "@/components/RichTextEditor";
import {
  previewAudience,
  sendCampaign,
  sendCampaignTest,
  uploadCampaignImage,
  type CampaignState,
} from "@/app/actions/campaigns";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { StickyActionArea } from "@/components/responsive-patterns";
import {
  FeedbackBanner,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/visual-system";

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
  const selectedSegment = segments.find((segment) => segment.id === segmentId);
  const selectedChannelConfigured = channel === "email" ? smtpConfigured : smsConfigured;
  const hasMessage = channel === "email" ? Boolean(subject.trim() && html.trim()) : Boolean(smsBody.trim());

  useEffect(() => {
    let alive = true;
    const formData = new FormData();
    formData.set("channel", channel);
    formData.set("segmentId", segmentId);
    previewAudience(formData).then((result) => {
      if (alive) setCount(result.count);
    });
    return () => {
      alive = false;
    };
  }, [channel, segmentId]);

  async function runTest() {
    const formData = new FormData();
    formData.set("channel", channel);
    formData.set("subject", subject);
    formData.set("htmlBody", html);
    formData.set("body", smsBody);
    formData.set("testTo", testTo);
    setTestMsg(await sendCampaignTest(undefined, formData));
  }

  return (
    <form ref={formRef} action={formAction} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
      <input type="hidden" name="htmlBody" value={html} />
      <input type="hidden" name="segmentId" value={segmentId} />
      <input type="hidden" name="channel" value={channel} />

      <div className="min-w-0 space-y-5">
        <Surface className="p-5 sm:p-6">
          <SectionHeading
            title={
              <span className="flex items-center gap-2">
                <StepNumber>1</StepNumber>
                Campaign setup
              </span>
            }
            description="Name the campaign, choose its channel and define who should receive it."
            className="mb-5"
          />

          <div className="space-y-5">
            <div>
              <label className="label" htmlFor="campaign-name">Campaign name</label>
              <input
                id="campaign-name"
                name="name"
                className="input"
                required
                placeholder="e.g. Winter service special"
              />
            </div>

            <fieldset>
              <legend className="label">Channel</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChannelChoice
                  icon={Mail}
                  title="Email"
                  description="Rich content with open and click tracking"
                  selected={channel === "email"}
                  configured={smtpConfigured}
                  onClick={() => setChannel("email")}
                />
                <ChannelChoice
                  icon={MessageSquareText}
                  title="SMS"
                  description="Short, direct messages to opted-in mobiles"
                  selected={channel === "sms"}
                  configured={smsConfigured}
                  onClick={() => setChannel("sms")}
                />
              </div>
            </fieldset>

            <div>
              <div className="flex items-center justify-between gap-3">
                <label className="label" htmlFor="campaign-audience">Audience</label>
                {count !== null && (
                  <span className="text-xs font-medium text-primary tabular-nums">
                    {count.toLocaleString("en-ZA")} recipient{count === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <select
                id="campaign-audience"
                className="input"
                value={segmentId}
                onChange={(event) => setSegmentId(event.target.value)}
              >
                <option value="">All subscribers</option>
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                  </option>
                ))}
              </select>
              <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <UsersRound className="mt-0.5 size-3.5 shrink-0" />
                Opted-out customers are always excluded. Create reusable groups in the Audiences tab.
              </p>
            </div>
          </div>
        </Surface>

        <Surface className="p-5 sm:p-6">
          <SectionHeading
            title={
              <span className="flex items-center gap-2">
                <StepNumber>2</StepNumber>
                Build the message
              </span>
            }
            description={
              channel === "email"
                ? "Create a clear subject and a focused message for your audience."
                : "Keep the message concise, useful and easy to act on."
            }
            action={
              <StatusPill tone="info">
                {channel === "email" ? "Email" : "SMS"}
              </StatusPill>
            }
            className="mb-5"
          />

          {channel === "email" ? (
            <div className="space-y-5">
              {templates.length > 0 && (
                <div>
                  <label className="label" htmlFor="campaign-template">
                    Start from a template
                  </label>
                  <div className="relative">
                    <FileText className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <select
                      id="campaign-template"
                      className="input pl-9"
                      defaultValue=""
                      onChange={(event) => {
                        const template = templates.find((item) => item.id === event.target.value);
                        if (template) {
                          setSubject(template.subject);
                          setHtml(template.body);
                        }
                      }}
                    >
                      <option value="">Blank campaign</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.subject || "(untitled)"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="label" htmlFor="campaign-subject">Subject</label>
                <input
                  id="campaign-subject"
                  name="subject"
                  className="input"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  required
                  placeholder="A clear reason to open this email"
                />
              </div>

              <div>
                <label className="label">Email content</label>
                <RichTextEditor
                  value={html}
                  onChange={setHtml}
                  onImageUpload={(file) => uploadCampaignImage(toFormData(file))}
                  placeholder="Hi {{first_name}}, …"
                />
                <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                  Use <code>{"{{first_name}}"}</code> to personalise. Unsubscribe, open tracking and
                  click tracking are added automatically.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between gap-3">
                <label className="label" htmlFor="campaign-message">Message</label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {smsBody.length} characters
                </span>
              </div>
              <textarea
                id="campaign-message"
                name="body"
                className="input min-h-40 resize-y"
                rows={7}
                value={smsBody}
                onChange={(event) => setSmsBody(event.target.value)}
                placeholder="Hi {{first_name}}, …"
                required
              />
              <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                Personalise with <code>{"{{first_name}}"}</code>. Keep links and the call to action
                easy to understand.
              </p>
            </div>
          )}
        </Surface>
      </div>

      <aside className="min-w-0 space-y-4 xl:sticky xl:top-5 xl:self-start">
        <Surface className="p-5">
          <SectionHeading
            title={
              <span className="flex items-center gap-2">
                <StepNumber>3</StepNumber>
                Review & launch
              </span>
            }
            description="Check the essentials, send yourself a test and then start delivery."
            className="mb-5"
          />

          <div className="rounded-xl border border-border bg-muted/25 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <UsersRound className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tracking-[-0.04em] tabular-nums">
                  {count === null ? "—" : count.toLocaleString("en-ZA")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {selectedSegment?.name ?? "All subscribers"}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2.5">
            <ReadinessItem
              ready={selectedChannelConfigured}
              label={`${channel === "email" ? "Email" : "SMS"} channel connected`}
            />
            <ReadinessItem ready={hasMessage} label="Message content added" />
            <ReadinessItem
              ready={count !== null && count > 0}
              label={count === 0 ? "Audience has no recipients" : "Audience ready"}
            />
            <ReadinessItem ready label="Consent exclusions applied" />
          </div>

          {!selectedChannelConfigured && (
            <FeedbackBanner tone="warning" title="Channel unavailable" className="mt-4">
              Configure {channel === "email" ? "email" : "SMS"} in Settings before sending.
            </FeedbackBanner>
          )}

          <div className="mt-5 border-t border-border pt-5">
            <label className="label" htmlFor="campaign-test-recipient">Send a test</label>
            <input
              id="campaign-test-recipient"
              className="input"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              placeholder={channel === "email" ? "you@email.com" : "0821234567"}
            />
            <button
              type="button"
              onClick={runTest}
              className="btn-secondary mt-2 w-full"
              disabled={!testTo.trim() || !selectedChannelConfigured}
            >
              <TestTube2 className="size-4" />
              Send test
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {testMsg?.ok && (
              <FeedbackBanner tone="success" title="Test sent">
                {testMsg.ok}
              </FeedbackBanner>
            )}
            {testMsg?.error && (
              <FeedbackBanner tone="danger" title="Test failed">
                {testMsg.error}
              </FeedbackBanner>
            )}
            {state?.ok && (
              <FeedbackBanner tone="success" title="Campaign started">
                {state.ok}
              </FeedbackBanner>
            )}
            {state?.error && (
              <FeedbackBanner tone="danger" title="Campaign could not start">
                {state.error}
              </FeedbackBanner>
            )}
          </div>

          <StickyActionArea className="mt-5 border-t border-border pt-4 sm:border-t sm:pt-4">
            <ConfirmActionDialog
              title="Send this campaign?"
              description={`This will send to ${count ?? "all available"} recipient${count === 1 ? "" : "s"}. Opted-out customers remain excluded.`}
              confirmLabel="Start sending"
              onConfirm={() => formRef.current?.requestSubmit()}
              trigger={
                <button
                  type="button"
                  className="btn-primary w-full"
                  disabled={
                    pending ||
                    !selectedChannelConfigured ||
                    !hasMessage ||
                    count === null ||
                    count === 0
                  }
                >
                  <Send className="size-4" />
                  {pending ? "Starting…" : "Send campaign"}
                </button>
              }
            />
          </StickyActionArea>
        </Surface>

        <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-card/50 p-3 text-xs leading-5 text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          Sending starts immediately after confirmation. Use a test message to check content and links.
        </div>
      </aside>
    </form>
  );
}

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-[11px] font-semibold text-primary">
      {children}
    </span>
  );
}

function ChannelChoice({
  icon: Icon,
  title,
  description,
  selected,
  configured,
  onClick,
}: {
  icon: typeof Mail;
  title: string;
  description: string;
  selected: boolean;
  configured: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!configured}
      aria-pressed={selected}
      className={`group flex min-h-24 items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
        selected
          ? "border-primary/50 bg-primary/10"
          : "border-border bg-muted/20 hover:border-border/90 hover:bg-muted/40"
      } ${!configured ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-xl border ${
          selected
            ? "border-primary/20 bg-primary text-primary-foreground"
            : "border-border bg-card text-muted-foreground"
        }`}
      >
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {title}
          <span className="text-[10px] font-normal text-muted-foreground">
            {configured ? "Ready" : "Not connected"}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function ReadinessItem({ ready, label }: { ready: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`grid size-5 shrink-0 place-items-center rounded-full border ${
          ready
            ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
            : "border-border bg-muted/50 text-muted-foreground"
        }`}
      >
        {ready ? <Check className="size-3" /> : <span className="size-1 rounded-full bg-current" />}
      </span>
      <span className={ready ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

function toFormData(file: File) {
  const formData = new FormData();
  formData.set("file", file);
  return formData;
}
