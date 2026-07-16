# Denago CRM

A custom CRM and EV service management system for Denago Cape Town. Built with Next.js 16, TypeScript, Prisma, and Tailwind CSS. Dark-themed, branded with the Denago Cape Town EV identity.

## Features

- **Leads pipeline** — drag-and-drop kanban board with configurable stages, won/lost tracking, lead → contact conversion, and value tracking in ZAR.
- **Products catalog** — the real Denago Cape Town range (City Cart, Scout 2/4, Nomad, Nomad XL, Rover XL, Rover XL 6, Rover XXL) with per-model colours and prices. The lead form auto-fills value and colour options from the selected model; website/Facebook intake matches models automatically.
- **Contacts** — card or list view with tags, avatars, and full profiles: communication history, documents, vehicles, activities, and linked leads.
- **Activities (Odoo-style chatter)** — schedule calls, emails, meetings, WhatsApps, and to-dos against any lead or contact with due dates and assignees. Overdue/today grouping on the Activities page and a "My activities" list on the dashboard; completing an activity can log an outcome note to the timeline.
- **Email flows** — configure any SMTP mailbox in Settings, build reusable email templates with `{{placeholders}}`, and send from any lead/contact with one click. Every send is logged to the communications timeline.
- **Automations** — no-code rules: *when* a lead is created / enters a stage / goes idle for N days → *then* schedule an activity, send a template email, move the lead, or assign a team member. Runs on events, on dashboard load, and via `/api/cron/automations`.
- **Communications** — log calls, emails, WhatsApp chats, meetings, and notes against any contact or lead, attributed to the team member who logged them.
- **Documents** — upload files (ID copies, invoices, warranty forms…) to contacts, vehicles, or job cards. Stored in `storage/uploads/`, downloads require login.
- **EV service module** —
  - Vehicle registry per customer (model, VIN/serial, colour, purchase date, warranty).
  - Mileage log and service history.
  - Next-service-due engine: due by date and/or km, from explicit next-due values or the vehicle's service intervals. Dashboard shows overdue / due-soon vehicles.
  - Workshop job cards with parts & labour line items and cost totals. Completing a job card automatically writes a service record and computes the next due service.
- **Lead intake** —
  - **Facebook/Instagram Lead Ads**: webhook at `/api/webhooks/meta` (verification + leadgen events, fetches lead details from the Graph API, dedupes retries, captures a stub lead if the token is missing so nothing is lost).
  - **Website forms**: `POST /api/intake` with an `X-Api-Key` header. Accepts `name, email, phone, message, model, color, source`; matches `model` to the product catalog automatically.
- **Team auth** — email/password logins, shared access, actions attributed per user. Manage team members, pipeline stages, and integration keys under Settings.

## Getting started

```bash
npm install
npx prisma migrate dev     # creates the SQLite database and runs the seed
npm run dev                # http://localhost:3000
```

### Initial owner account

The seed creates the initial owner **only** from environment variables — there is no
default password in the repository:

- `INITIAL_ADMIN_EMAIL` — owner login email
- `INITIAL_ADMIN_PASSWORD` — owner password (**≥ 14 characters**)
- `INITIAL_ADMIN_NAME` — display name (optional)

In **production** the seed refuses to run without these. On **preview** deployments it
never creates a privileged owner. In **local dev**, if you set `INITIAL_ADMIN_EMAIL`
without a password, a random one-time password is printed to the console (existing
users' passwords are never overwritten).

## Configuration

Environment variables live in `.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `file:./dev.db` for local SQLite. Point at PostgreSQL in production (also change `provider` in `prisma/schema.prisma` to `postgresql` and re-run migrations). |
| `SESSION_SECRET` | Secret for signing login session tokens. Set a long random value in production. |

Integration keys (Meta verify token, Page access token, intake API key) are stored in the database and managed on the **Settings** page.

## Connecting Facebook Lead Ads

1. Deploy the app somewhere with a public HTTPS URL (Meta requires HTTPS).
2. Create an app at [developers.facebook.com](https://developers.facebook.com), add the **Webhooks** product, and subscribe to the **Page** object → `leadgen` field with:
   - Callback URL: `https://<your-domain>/api/webhooks/meta`
   - Verify token: from the Settings page.
3. Generate a Page Access Token with the `leads_retrieval` and `pages_manage_metadata` permissions and paste it into Settings.
4. Use a Lead Ads form with fields named so the CRM can map them: full name, email, phone number, and optionally questions containing "model" and "colour" in their names.

## Website form intake

```bash
curl -X POST https://<your-domain>/api/intake \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <key from Settings>" \
  -d '{"name":"Jane Doe","email":"jane@example.com","phone":"0821234567","model":"Denago City Model 1","color":"Blue","message":"Interested in a test ride"}'
```

## Email + automations setup

1. **Settings → Email (SMTP)**: enter your mailbox details (e.g. `sales@denagocpt.co.za`), then click "Send test email to me".
2. **Settings → Email templates**: a starter "New enquiry welcome" template is seeded; placeholders `{{first_name}}`, `{{model}}`, `{{color}}`, `{{value}}`, `{{user_name}}` fill from the lead.
3. **Settings → Automations**: two starter rules are seeded (call new leads within a day; nudge quiet leads after 4 days). Idle rules run when the dashboard loads, or schedule an external cron to hit `GET /api/cron/automations?key=<intake API key>` every few hours.

## Tech notes

- **Stack**: Next.js 16 (App Router, server actions), React 19, Prisma 6, SQLite (dev) / PostgreSQL (prod), Tailwind CSS 4, dnd-kit for the kanban board.
- **Money** is stored as integer cents (ZAR).
- **Auth**: JWT session cookie (jose, HS256, 30 days), bcrypt password hashes, route protection in `src/proxy.ts`.
- **Uploads** are stored on disk under `storage/uploads/` with random file names; the original name and metadata live in the database. Back this folder up along with the database.
- Run `npm run build && npm run start` for production.
