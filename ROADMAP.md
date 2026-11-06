# DenagoCRM Roadmap

Ideas agreed for later — not scheduled, in rough priority order. Statuses were re-checked against the code on 2026-11-06.

## Still open

### Outstanding-balances report (accounts receivable)

Payments against quotes (`QuotePayment`) and per-customer statements with running balances are built. What's missing is the cross-customer view: everyone who owes money, how much and how old.

### Online deposit payment (SA gateway)

PayFast / Yoco / Ozow on the signing portal, so a customer signs *and* pays the deposit in one flow.

### Accounting sync (Xero / Sage)

Push invoices and customers to accounting so the deal isn't captured twice.

### Full signing-portal wizard

A multi-step Review → Confirm details → Sign → Done flow for longer contractual documents, such as sales agreements and finance. The current one-screen flow converts better for quick quote acceptance.

### Social inbox — more channels

YouTube comments (Data API) and TikTok Lead Gen API. WhatsApp, Messenger, Instagram DMs, Google Reviews, Telegram and X are done.

### Borrow from Dittofeed (MIT)

Candidates are:
- MJML for responsive email HTML;
- their `emailo` low-code email editor;
- their subscription-group / unsubscribe model;
- their segment operator set, as comparison material.

Their journey *engine* is deliberately excluded: it needs Temporal, ClickHouse and Kafka. Scope and licence are covered in [docs/dittofeed-borrow-queue.md](docs/dittofeed-borrow-queue.md).

## Shipped since the 2026-07-08 feature review

- **Commerce and workshop:** stock and inventory with purchase orders and goods receipts; parts and labour on job cards; deliveries board.
- **Marketing:** lead-source ROI; bulk campaigns, surveys and referrals; the customer portal.
- **Money on the deal:** deposit and payment amounts on quotes, and customer account statements.
- **EV after-sales:** warranty with expiry and claims; battery health tracking.
- **Journeys:** the single automation engine with waits and branches. This replaced the idle-rule drip sequences.
- **WhatsApp chatbot phase 2:** a Claude answerer grounded in the workspace's knowledge base, with handoff to a person and knowledge-gap capture.
- **DAX:** the CRM assistant on web and WhatsApp, with voice, quote building, proactive briefs, quiet hours and the attention ranking.
- **Signing:** in-house e-signing with workflows, sealed PDFs and trusted timestamps; Document Studio.
- **Multi-workspace platform:** tenant isolation enforced with row-level security; per-workspace branding and custom domains; plans, usage and billing.
- **Earlier:** unified social inbox; IMAP inbound email; saved list views; module-based roles and permissions; AI assist (proofread and research); 2FA, passkeys and session policy; System Log.
