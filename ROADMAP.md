# DenagoCRM Roadmap

Ideas agreed for later — not scheduled, in rough priority order.

## Full signing-portal wizard (requested 2026-07-07)

Upgrade the public signing page from a single-scroll document to a multi-step
portal: **Review document → Confirm your details → Sign → Done**, with a
progress indicator and a per-step terms acknowledgment checkbox.

- Builds on the existing "paper on a desk" signing page (`/sign/[kind]/[token]`)
  — same token auth, expiry, decline, viewed-tracking and PDF filing stay as-is.
- Step state can live client-side in `SignPanel`; no schema changes needed.
- Worth adding when Denago starts signing longer/contractual documents online
  (sales agreements, finance paperwork) where the extra ceremony and explicit
  acknowledgments earn their friction. For quick quote acceptance the current
  one-screen flow converts better.

## Unified social inbox (requested 2026-07-07)

One Inbox page listing every unanswered inbound message across channels,
each linked to its customer record with an in-CRM reply box. Channels are
adapters over the existing Communication model (WhatsApp panel = the
template).

Phases, in value order:
1. **Facebook Messenger + Instagram DMs** — same Meta app as lead ads;
   needs `pages_messaging` + `instagram_manage_messages` in the same app
   review as leads. Webhook → contact/lead match → chat panel → reply.
   Mind the 24-hour reply window.
2. **Google Reviews** — Business Profile API: new-review push, reply from
   CRM, and auto-request a review on job-card completion / signed quote.
3. **YouTube comments** — own-channel read/reply via YouTube Data API.
4. **TikTok** — Lead Generation API only (flows in like Meta leads);
   DMs are not available to regular businesses. Comments possible with
   app approval.

## Previously parked

- Follow-up sequences (multi-step drip; approximated today with multiple idle
  automation rules)
- Roles / permissions (all users currently share full access by choice)
- Parts inventory on job cards
- IMAP inbound email sync (replies land in the CRM automatically)
