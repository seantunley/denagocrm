# Onboarding a new tenant

**Audience:** whoever runs onboarding for the platform.
**Time:** about 40 minutes of hands-on work, plus DNS propagation.
**You will need:** a platform administrator account, access to the Vercel project, and the customer's answers to the four questions in [§1](#1-collect-what-you-need-from-the-customer).

A "tenant" is one customer's entire workspace: their staff, their customers, their documents, their branding and their web address. Tenants cannot see each other's data.

---

## Before you begin: the one blocking prerequisite

**Tenant isolation enforcement must be switched on before a second tenant can be activated.**

This is not a formality. Until `TENANT_ENFORCEMENT=enforce` is live, the platform console will refuse to activate a new tenant and tell you:

> Tenant isolation enforcement must be enabled before activating additional tenants — activating now would expose existing data.

You can still create the tenant, brand it and register its domain — all of that is inert and safe. It simply cannot be switched on. The refusal is deliberate: without enforcement there is no boundary between workspaces, so an active second tenant would be able to see the first one's records.

Turning enforcement on is a separate, carefully ordered piece of work. It has its own runbook — **`DEPLOYMENT-SEQUENCE.md`** — and it must be followed in order. Confirm enforcement is live before promising a customer a go-live date.

**Related:** `docs/RLS-ROLE-CUTOVER.md` covers the database role change that makes isolation enforceable at the database level rather than only in the application. Recommended before onboarding real customers.

---

## 1. Collect what you need from the customer

Four things. Everything else you can decide or change later.

| What | Example | Notes |
|---|---|---|
| **Workspace name** | `Acme Golf Carts` | Appears on their sign-in page, documents and emails. |
| **Web address** | `crm.acmegolf.co.za` | A subdomain they control. They will need to add one DNS record. |
| **First administrator** | `jane@acmegolf.co.za` | One named person. They can add colleagues themselves afterwards. |
| **Which modules** | Marketing, Workshop… | See [§5](#5-choose-their-modules). Can be changed at any time. |

Optional, and easy to add later: their logo (PNG, JPEG, SVG or WebP, under 1 MB) and a brand accent colour as a six-digit hex code, for example `#ea580c`.

> **A note you can forward to the customer**
>
> To set up your workspace we need: the name you want it to trade under, the web address you would like it on (for example `crm.yourcompany.co.za`), and the name and email address of the first administrator. If you have a logo and a brand colour, send those too — otherwise we can add them later without any disruption.
>
> You will need someone with access to your domain's DNS to add a single record. It takes a few minutes; we will send you the exact value.

---

## 2. Make sure you can sign in to the platform console

The platform console is separate from the CRM. It has its own login page, its own accounts and its own passwords. A tenant's administrator — including your own — has no access to it.

- **Console:** `https://<your-platform-domain>/platform/login`
- **CRM:** `https://<your-platform-domain>/login`

Signing in to one does not sign you in to the other. This is intentional.

### If you do not have a platform administrator account yet

There is no signup page and no "create the first admin" screen, on purpose — such a page would be a takeover route the moment it misbehaved. Accounts are created from the command line, which requires database credentials:

```bash
npm run platform:create-admin -- \
  --email ops@yourcompany.com \
  --name "Platform Operations" \
  --yes
```

Leave `--password` off and a strong one is generated and printed **once**. Save it immediately.

Passwords must be at least 12 characters and contain both a letter and a digit.

> **Treat this password as the only lock on the door.** The platform console has no two-factor authentication — the database columns for it exist, but there is no screen to enrol one, so it cannot currently be switched on. A platform administrator can create, brand and suspend every tenant on the platform, and a password is all that stands in front of that. Use a long generated one, store it in a password manager, and give out platform accounts sparingly. Tenant *users* are unaffected: the CRM has full two-factor support, including passkeys, at **Settings → My Account**.

---

## 3. Create the tenant

In the console, go to **Tenants → Create tenant** and complete:

| Field | Rules |
|---|---|
| **Name** | Free text. The trading name. |
| **Slug** | Lowercase letters, numbers and single hyphens only — `acme-golf-carts`. Permanent identifier; choose carefully. |
| **Owner name** | The first administrator's full name. |
| **Owner email** | Must not already exist anywhere on the platform. |
| **Owner password** | At least 12 characters, with letters and numbers. |

### What happens when you submit

The tenant is created **inert**, and this is worth understanding before you tell the customer anything:

- The workspace exists but is **suspended**.
- The administrator account exists but is **disabled** and cannot sign in.
- Nothing is reachable, and nothing has been sent to anyone.

That is the correct and safe state. You now have somewhere to put their branding and their domain, with no live door into the platform. The account only becomes usable at [§7](#7-activate-the-tenant).

> **Command-line alternative.** The same result, useful for scripted setups:
> ```bash
> tsx scripts/create-tenant.ts \
>   --name "Acme Golf Carts" --slug acme-golf-carts \
>   --owner-email jane@acmegolf.co.za --owner-name "Jane Doe" \
>   --yes
> ```
> It prints the target database host and refuses to write without `--yes`. Check that host before confirming.

---

## 4. Set up their web address

Three parts, in this order. Getting the order wrong is the most common cause of a failed setup, because the platform will refuse to verify a domain that does not yet answer.

### 4a. Add the domain to the Vercel project

In Vercel, open the project and go to **Settings → Domains → Add**. Enter the customer's hostname, for example `crm.acmegolf.co.za`.

Vercel will show you the DNS record it needs. Usually a `CNAME` pointing at `cname.vercel-dns.com`.

**This step cannot be skipped or done later.** Every tenant domain serves the same deployment — that is what makes per-customer branding work at all — so the address has to be attached to the project before anything will answer on it.

### 4b. Have the customer add the DNS record

Send them the exact record Vercel displayed. They add it with their domain registrar or DNS provider.

DNS changes usually take a few minutes and occasionally a few hours. Wait until `https://crm.acmegolf.co.za` loads a sign-in page before continuing. It will be unbranded at this stage — that is expected.

### 4c. Register and verify the domain in the console

In the console, open the tenant, go to the **Branding** tab and scroll to **Domains**.

1. **Add the hostname.** Enter it bare — no `https://`, no port, no trailing path. It is saved **unverified**, which changes nothing: an unverified hostname serves no branding.
2. **Click Verify.** The platform now makes a live request to that address and checks the response came from this deployment.

Verification either succeeds, or it tells you exactly what is wrong:

| Message | What it means | Fix |
|---|---|---|
| Could not reach `https://…` | DNS is not pointing here yet, or has not propagated | Wait, then re-check the DNS record |
| `…` answered with HTTP 404 | DNS resolves, but the domain is not attached to the project | Do step **4a** |
| `…` is serving something else | Another site is on that address | Check the DNS record points where Vercel asked |
| `…` responded, but not as this deployment | It reached a different environment | Check it is not pointed at a staging deployment |

This check exists because of what depends on it. Once a domain is verified, the platform starts putting it in outgoing email — signing links, survey invitations, marketing links, unsubscribe links. A domain marked verified but not actually working sends every one of those to an address that does not resolve, and nothing anywhere reports an error. The customer would find out when someone told them a link was broken.

---

## 5. Choose their modules

Open the tenant's **Modules** tab and switch on what they have bought.

| Module | What it gives them |
|---|---|
| **CRM core** | Contacts, leads, quotes, activities. Always on. |
| **Social inbox** | WhatsApp, Messenger, Instagram and Telegram conversations |
| **Help desk** | Customer support ticketing |
| **Marketing** | Campaigns, segments, journeys |
| **Automation & AI** | Automated workflows and assistants |
| **Automotive / Workshop** | Job cards, vehicles, service scheduling |
| **Stock & inventory** | Stock units, transfers, purchase orders |
| **Customer portal** | A self-service area for their customers |

Modules can be changed at any time, including after go-live. Switching one off hides it; it does not delete anything.

---

## 6. Apply their branding

Open the tenant's **Branding** tab.

| Setting | Notes |
|---|---|
| **Display name** | Up to 120 characters. Replaces the platform name everywhere the customer's people and their customers see it. |
| **Tagline** | Up to 160 characters. The line under the name on their sign-in page. Optional. |
| **Accent colour** | Six-digit hex, `#ea580c`. Leave blank to keep the default. Text colour on it is calculated automatically, so it will always be readable. |
| **Logo** | PNG, JPEG, SVG or WebP, under 1 MB. |

Branding applies **only on a verified hostname**. If you set it before finishing [§4](#4-set-up-their-web-address), nothing appears to change — that is not a fault, it is the same rule that stops an unproven address serving someone's brand.

Once verified, the branding reaches:

- their staff sign-in page and the whole CRM
- their customer portal and their signing pages
- documents — quotes, job cards, agreements
- outgoing email, including the logo and the links

**Documents already signed never change.** The brand a signed document was issued under is frozen into it at the moment of signing, so a later rebrand cannot alter what a customer already agreed to.

---

## 7. Activate the tenant

Back on the tenant's page, click **Activate**.

This does two things at once: it switches the workspace on, and it re-enables the administrator account you created in [§3](#3-create-the-tenant). Until this moment neither could be used.

If you get the enforcement refusal described at the top of this guide, stop. The tenant is fine and nothing is lost — but it cannot go live until enforcement is enabled.

---

## 8. Hand over

Send the administrator:

- their sign-in address — `https://crm.acmegolf.co.za/login`
- their email address and the password you set
- a request to change that password immediately

### What they should do first

Point them at **Settings → Company profile** and ask them to fill it in: trading name, address, phone, email, website, socials.

This is worth insisting on. Those details print on every quote, job card and signed agreement they issue. Until the profile is filled in, documents show their name and little else — not wrong, but sparse.

Then:

- **Settings → Team & access** — add their colleagues and set permissions
- **Settings → Email** — connect their own mail server, so email goes out from their address rather than the platform's
- **Settings → Documents** — adjust quote and agreement templates

---

## 9. Confirm it works

Before you call it done, do this yourself on the customer's domain:

1. Open `https://<their-domain>/login` — their name, logo and colour should be there.
2. Sign in as the administrator.
3. Create a test contact and a test quote.
4. Print the quote — the header and footer should carry their details.
5. Email something from the CRM — check the signature.
6. Open the customer portal sign-in page and confirm it is branded.

Then, importantly, **sign in as your own platform account on your own domain** and confirm you see only your own data. Two workspaces, no overlap.

---

## Removing a tenant

Use **Suspend** rather than deletion. It closes every door — nobody can sign in — while leaving the data intact for as long as you need it.

The founding tenant cannot be suspended. It underpins the platform's own accounts and sessions, and switching it off would lock everyone out, so the console refuses.

---

## Quick reference

| Step | Where | Blocking? |
|---|---|---|
| Enforcement enabled | `DEPLOYMENT-SEQUENCE.md` | **Yes** — activation fails without it |
| Platform admin account | Command line | Yes |
| Create tenant | Console → Tenants → Create tenant | — |
| Domain added to Vercel | Vercel → Settings → Domains | **Yes** — verification fails without it |
| DNS record added | Customer's DNS provider | **Yes** — verification fails without it |
| Domain verified | Console → tenant → Branding → Domains | **Yes** — no branding without it |
| Modules chosen | Console → tenant → Modules | No |
| Branding applied | Console → tenant → Branding | No |
| Tenant activated | Console → tenant → Activate | **Yes** — nobody can sign in without it |
| Company profile completed | Customer, in Settings → Company profile | No, but documents look bare |
