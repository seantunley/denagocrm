# Customer Portal Expansion

## Scope

This change expands the existing OTP-authenticated customer portal into a self-service customer, fleet, service, warranty and support workspace.

It does not add invoices, statements, payment history, payment collection or accounting functions.

## Capabilities

- Existing OTP email login remains in place.
- Direct customer access plus delegated contact/account and fleet access.
- Owner-managed portal access grants with viewer, manager and owner labels.
- Vehicle and fleet visibility.
- Service status and service history.
- Service booking requests with server-side vehicle ownership validation.
- Warranty status, claim history and warranty-request submission.
- Support cases with customer/staff conversation history.
- Quote review/signing and delivery status.
- Scoped customer, vehicle, quote and delivery-document downloads.
- Secure customer uploads linked to a vehicle or support case.
- Profile and address change requests rather than direct protected-record mutation.
- Service, SMS, portal-notification and marketing preferences.
- POPIA marketing-consent ledger updates.
- Portal notifications and read state.
- Recent customer communication history.

## Migrations

Apply in order:

1. `46_customer_portal_expansion`
2. `47_portal_preferences`

The migrations are additive. Migration 46 creates portal access, customer cases, case messages, notifications, profile requests, preferences and secure uploads. Migration 47 extends the preference record with channel-specific fields.

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

Every vehicle ID submitted from a portal form is revalidated server-side. Client-provided IDs are never trusted.

## File security

- Upload limit: 10 MB.
- Accepted types: PDF, JPG, PNG and WebP; the overview upload also accepts plain text.
- Portal downloads use authenticated scoped routes.
- Files are returned as attachments with `nosniff` and `private, no-store`.
- Raw Vercel Blob URLs are not exposed as portal download links.

## Administration

Owners manage delegated portal access at:

```text
/settings/portal-access
```

Use contact grants for another person/account record and fleet grants for fleet-wide vehicle visibility.

## Preview verification

1. Apply both migrations to a Neon preview branch.
2. Log in as a normal customer and confirm only that customer’s records appear.
3. Attempt to submit another customer’s vehicle ID directly and confirm it is rejected.
4. Grant a second contact record and confirm it appears.
5. Grant a fleet and confirm its vehicles appear.
6. Revoke the grant and confirm access disappears immediately.
7. Create a support case and reply to it.
8. Submit a warranty request against an accessible vehicle.
9. Submit a service request.
10. Upload each allowed file type and reject an unsupported type or oversized file.
11. Confirm customer documents download only through scoped portal routes.
12. Update marketing preferences and verify `marketingOptOut` plus the POPIA consent ledger.
13. Submit profile changes and verify the CRM record is not changed until staff review.
14. Confirm portal notifications can be marked read.
15. Run lint, typecheck and a production build before merge.

## Rollback

Roll back application code before removing portal tables. Uploaded files must be retained or migrated before dropping `PortalUpload`. Revoke portal grants rather than deleting customer history during a normal operational rollback.
