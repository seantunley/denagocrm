# Email signatures as their own pack: build plan

*20 November 2026.*

**Sean's decisions:**
- "I think it needs its own module now."
- A **switchable pack with its own page**.
- The first build covers items **1–5** of `email-signature-improvements.md`: more per-person details, a visual editor with locked fields, signatures by team, a short reply signature, and more designs with each workspace's colours.

## How packs work today, and what that means here

- **A pack is on only when it is granted.** Packs are listed in `src/lib/modules/registry.ts`. A workspace may use a pack only if it's listed in `Tenant.modules`, which a platform admin grants in the console, and only if the owner hasn't switched it off (the `DISABLED_MODULES` setting). Empty means core only.
- **So a new pack starts off for every workspace.** On production today, Denago Cape Town and Breastfeeding Art have explicit grants. Neither has signature banners or custom-HTML signatures.
- **Off must change nothing.** Emails keep exactly today's automatic signature, including the saved card or classic design. Banners stop, and none exist today. When the pack is granted and on, the new page and features appear.
- **Granting:** a platform admin ticks "Email signatures" for a workspace in the console. No data migration is needed.

## PR 1: the pack and its page (nothing new for senders yet)

- **The pack:** `registry.ts` gets `signatures`, labelled "Email signatures", with route prefix `/email-signatures`.
- **The page:** `/email-signatures` brings together what is scattered today:
  - the workspace design (owner), moved from Settings;
  - banners (owner), moved from `/settings/signature-banners`;
  - "my signature" (everyone): preview and personal override.
- **The menu:** an entry under Marketing or Admin, shown only when the pack is on.
- **Old locations** point to the new page when the pack is on. When it's off, they say the pack is off and the automatic signature is in use.
- **Senders:** composer, quote email and document editor stay unchanged when the pack is on. When it's off, banners are skipped and everything else is as today.

## PR 2: details, the locked-field editor, team signatures, the reply version (items 1–4)

- **New per-person fields** (an additive migration on `User`): photo, qualifications, direct line, WhatsApp, booking link, working hours.
- **Workspace design gains:**
  - which fields staff may change;
  - per-team overrides of lines, for example workshop hours;
  - a reply variant with two lines.
- **The raw-HTML override** stays for the owner only, behind "Advanced". Staff edit only the unlocked fields.
- **The reply signature** is used when the composer is replying, from `inReplyTo` or a thread.

## PR 3: more designs and brand colours (item 5)

- **Three or four more layouts.**
- **Colours** come from `Tenant.brandPrimary` / brand settings instead of the fixed `CARD_ORANGE` / `CARD_DARK`. Breastfeeding Art has a brand colour set; Denago has none and keeps today's orange.

## Then: the rest of the document (Sean: "The document needs to be built. Copy my signature can be left out. Its built in PR1161")

| Item | Built as |
| --- | --- |
| 2. Visual editor | Your details on the left, your signature redrawn as you type on the right. Locked details show greyed with a padlock. The owner edits each team member in the same editor. |
| 6. Legal lines | The workspace already has an email legal line at the foot of every email (set on Signature banners). The Rules section edits that same line, and adds a privacy policy link under every signature. No second notice. |
| 7. Preview across mail apps | Computer / Phone / Dark mode views of the preview, and "Send myself a test": the real email to your own address. |
| 8. Completeness nudges | The owner sees whose signature is missing a job title or mobile; each person sees their own. |
| 9. Copy my signature | Not here: built in #1161. |
| 10. Personal call-to-action | "Your own line": one more detail, lockable like the rest. |
| 11. Link analytics | Off until the owner ticks "Count clicks on signature links". Web links only (website, WhatsApp, booking, socials, privacy); phone and email links can't go through a web page without breaking. Clicks by link and by person. |

PR 3's colours reach the card too, as item 5 warned: its orange website link and stripe become the workspace's colour (the stripe a straight bar). Colour and the three new designs (Modern, Compact, Minimal) apply only while the pack is on; Denago has no colour set, so it keeps its orange.

## Rules carried

- New features go in their own files; the big files get only the wiring.
- Workspace settings name the tenant (`getWorkspaceSetting`).
- Nothing is hidden from the UI.
- No customer sends without a click.
- Workspace isolation is checked on every new query.
