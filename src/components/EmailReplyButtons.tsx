"use client";

import { COMPOSE_REPLY_EVENT, splitTimelineEmail, type ComposeReplyDetail, type ReplyKind, type TimelineEmail } from "@/lib/emailReply";

/**
 * Reply / Reply all / Forward under an email on the timeline. The timeline is
 * drawn on the server and the composer lives beside it on the page, so the
 * button announces the email and the composer (EmailComposer) opens itself with
 * it. Reply all shows only when the email had a Cc the CRM knows of — for any
 * other email it would do exactly what Reply does.
 */
export default function EmailReplyButtons({ email }: { email: TimelineEmail }) {
  const open = (kind: ReplyKind) =>
    window.dispatchEvent(new CustomEvent<ComposeReplyDetail>(COMPOSE_REPLY_EVENT, { detail: { email, kind } }));
  const button = "cursor-pointer text-slate-400 hover:text-orange-400";
  return (
    <div className="mt-1 flex gap-3 text-xs">
      <button type="button" className={button} onClick={() => open("reply")}>↩ Reply</button>
      {splitTimelineEmail(email.body).cc && <button type="button" className={button} onClick={() => open("reply-all")}>↩ Reply all</button>}
      <button type="button" className={button} onClick={() => open("forward")}>↪ Forward</button>
    </div>
  );
}
