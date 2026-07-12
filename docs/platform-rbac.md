# Platform-wide RBAC

## Purpose

DenagoCRM now treats database-backed roles and permissions as the authoritative access-control layer for CRM, customer operations, documents, marketing, workshop and reporting features. Legacy `User.modules` flags remain only for a small number of unmigrated or owner-only screens.

Navigation visibility is not a security boundary. Every migrated page, server action and protected file route validates permissions again on the server.

## Scope levels

The main customer and sales records use two read scopes:

- `*.view_all`: organisation-wide access.
- `*.view_owned`: records owned, created, assigned or reached through one of the user's teams.

The scoped record graph is:

1. Leads are accessible when assigned to the user, created by the user, or assigned to a team the user belongs to or manages.
2. Contacts are accessible when owned/created by the user, linked to an accessible lead, or linked to a job card assigned to the user.
3. Quotes inherit access from their creator, linked lead or linked contact.
4. Vehicles inherit access from their customer/fleet or an assigned job card.
5. Job cards inherit access from the technician, customer or vehicle.
6. Documents inherit access from the uploader or their linked customer, quote, vehicle or job card.
7. Customer cases inherit access from their customer or vehicle.
8. Activities inherit access from their assignee/creator or linked lead/contact.

Mutation permissions such as `quotes.edit`, `documents.manage` and `jobcards.manage` do not bypass record scope. A user needs both the operation permission and access to the target record.

## Default roles

### CRM administrator

Organisation-wide access to all permissions except infrastructure ownership, which remains protected by the legacy `owner` account boundary.

### Sales manager

Team-scoped sales, customer, quote, document, case, vehicle, job-card and reporting visibility. Managers can configure pipelines, forecasts and team membership. Organisation-wide access can be granted through a custom role or CRM Administrator.

### Sales representative

Own/team leads, contacts, quotes, documents, cases, vehicles and activities, plus the mutations needed for normal selling and follow-up.

### Marketing user

Campaigns, surveys, journeys and opted-in customer audiences. Marketing users receive customer visibility required to resolve audiences, but do not receive sales mutation rights.

### Workshop manager

Organisation-wide vehicle, job-card, parts, warranty, fleet, document and workshop activity access.

### Technician

Assigned/customer-linked vehicles and job cards, parts access, warranty visibility, document upload, and workshop activity management.

### Auditor

Read-only organisation-wide sales, customer, quote, document, case, workshop, report, forecast and immutable audit access.

## Permission-aware user interface

The application shell resolves the current permission list from PostgreSQL on each server render. The sidebar, command palette and quick-create menu are built from that list. Role changes also bump the user's session version, immediately invalidating stale sessions.

## Protected downloads

`/api/files/[id]` validates staff document scope or customer-portal scope before reading Vercel Blob/local storage. Knowing a document ID is not sufficient to download it.

## Reporting

- `reports.view_all` grants organisation-wide reporting.
- `reports.view_team` and the compatibility `reports.view` grant reporting over the user's permitted team/record scope.
- Report filters only include users within the permitted scope.

## Document Studio

The application now exposes two clearly separated document tools:

- **Operational templates** control the built-in quote, invoice, sales agreement, indemnity, delivery note, job-card, service-report and warranty-claim PDFs.
- **Free-form Studio templates** create standalone custom documents from BlockNote blocks, merge fields and reusable clauses.

Template administration requires `document_templates.manage`. Repository viewing and document-instance editing use document read/manage permissions and linked-record scopes.

## Validation

The GitHub workflow applies all migrations to isolated PostgreSQL and runs:

```bash
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm run lint
npm run build
npm run verify:governance
npm run test:security
npm run test:rbac
```

`test:rbac` creates a user, teammate and unrelated user with leads, contacts, quotes, vehicles, job cards, documents, cases and activities. It verifies that the scoped user sees their own and team records but never the unrelated records.

## Manual acceptance checks

1. Assign a Sales Representative to one team and confirm they cannot open another team's lead/contact/quote IDs directly.
2. Confirm the same restriction applies to vehicles, job cards, cases and documents.
3. Confirm a guessed `/api/files/<id>` returns `403` for an inaccessible file.
4. Confirm search results contain only permitted records.
5. Confirm Sales Manager reports show only managed/member teams.
6. Confirm CRM Administrator and Auditor organisation-wide read scopes behave as configured.
7. Remove a role or permission and confirm the user's current sessions are invalidated.
8. Confirm read-only users do not see mutation controls and direct action submissions are rejected.
9. Confirm Document Studio operational templates edit the matching built-in PDFs.
10. Confirm portal customer access remains isolated from staff RBAC.
