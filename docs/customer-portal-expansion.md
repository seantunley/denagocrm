# Customer Portal Expansion

## Scope

This change expands the existing OTP-authenticated customer portal into a self-service customer, fleet, service, warranty, document and support workspace.

It does not add invoices, statements, payment history, payment collection or accounting functions.

## Capabilities

- Existing OTP email login remains in place.
- Direct customer access plus delegated contact/account and fleet access.
- Owner-managed portal access grants with viewer, manager and owner labels.
- Vehicle and fleet visibility.
- Service status and service history.
- Service booking requests with server-side vehicle ownership validation.
- Warranty status and warranty-request submission.
- Support cases with customer/staff conversation history.
- Internal customer-case inbox at `/cases`.
- Quote review/signing and delivery status.
- Scoped customer, vehicle, quote and delivery-document downloads.
- Secure customer uploads linked to a vehicle or support case.
- Profile and address change requests rather than direct protected-record mutation.
- Owner approval/rejection workflow for profile changes.
- Service, SMS, portal-notification and marketing preferences.
- POPIA marketing-consent ledger updates.
- Portal notifications and read state.
- Delegated fleet and account administration at `/settings/portal-access`.

## Migrations

Apply in order:

1. `46_customer_portal_expansion`
2. `47_portal_preferences`

The migrations are additive. Migration 46 creates portal access, customer cases, case messages, notifications, profile requests, preferences and secure uploads. Migration 47 extends preference records with channel-specific fields and adds the staff profile-review note.

## Access control

All portal record access is resolved through `src/lib/portalAccess.ts`.

The signed-in contact may access:

- Their own contact record.
- Explicitly granted contact/account records.
- Explicitly granted fleets.
- Fleets where an accessible contact is the primary fleet contact.
- Vehicles owned by an accessible contact or fleet.
- Quotes belonging to accessible contacts.
- Documents related to accessible contacts, vehicles or quotes.
- Cases related to accessible contacts or fleets.

Every contact, vehicle, case, upload and document ID submitted from a portal form is revalidated server-side. Client-provided IDs are never trusted.

Staff case pages are gated to CRM or Workshop users. Staff upload downloads additionally check CRM, Workshop, Inbox or owner access.

Portal grant roles are currently descriptive access levels. They do not yet restrict individual portal actions differently; all active grants expose the target records. Fine-grained portal-role actions should be added in a later RBAC integration.

## File security

- Upload limit: 10 MB.
- Accepted types: PDF, JPG, PNG and WebP.
- Portal and staff downloads use authenticated scoped routes.
- Files are returned as attachments with `nosniff` and `private, no-store`.
- Raw Vercel Blob URLs are not exposed as portal download links.

## Administration

Owners manage delegated portal access and pending profile requests at:

```text
/settings/portal-access
```

CRM and Workshop users manage customer cases at:

```text
/cases
```

Use contact grants for another person/account record and fleet grants for fleet-wide vehicle visibility.

## Backup integration note

The portal tables are introduced through additive SQL migrations and are not represented in the current single-file Prisma schema on `main`.

When this PR is combined with the backup-upgrade PR, confirm the logical backup includes:

- `PortalAccessGrant`
- `CustomerCase`
- `CustomerCaseMessage`
- `PortalNotification`
- `PortalProfileChangeRequest`
- `PortalPreference`
- `PortalUpload`

The backup PR's schema-driven Prisma export cannot discover raw-SQL-only tables. Before merging both features to production, either add these models to Prisma or explicitly register these tables in the portability exporter. Neon restore/PITR remains the primary database recovery mechanism.

## Preview verification

1. Apply both migrations to a Neon preview branch.
2. Log in as a normal customer and confirm only that customer's records appear.
3. Attempt to submit another customer's contact, vehicle, case, document or upload ID and confirm it is rejected.
4. Grant a second contact record and confirm it appears.
5. Grant a fleet and confirm its vehicles appear.
6. Revoke the grant and confirm access disappears immediately.
7. Create a support case, reply as staff, reply as the customer and change case status.
8. Submit a warranty request against an accessible vehicle.
9. Submit a service request.
10. Upload each allowed file type and reject an unsupported type or oversized file.
11. Confirm customer documents download only through scoped portal routes.
12. Confirm staff upload downloads reject users without the required modules.
13. Update marketing preferences and verify `marketingOptOut` plus the POPIA consent ledger.
14. Submit profile changes, approve one and reject another; verify only approved changes reach the CRM record.
15. Confirm portal notifications can be marked read.
16. Confirm quote signing and delivery status still work.
17. Run lint, typecheck and a production build before merge.
18. Confirm the combined backup design covers every portal table and Vercel Blob upload.

## Rollback

Roll back application code before removing portal tables. Uploaded files must be retained or migrated before dropping `PortalUpload`. Revoke portal grants rather than deleting customer history during a normal operational rollback.

Cases, messages, profile requests, consent records and notifications are customer history and should not be deleted as a normal rollback step.
