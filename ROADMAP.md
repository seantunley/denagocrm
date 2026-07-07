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

## Previously parked

- Follow-up sequences (multi-step drip; approximated today with multiple idle
  automation rules)
- Roles / permissions (all users currently share full access by choice)
- Parts inventory on job cards
- IMAP inbound email sync (replies land in the CRM automatically)
