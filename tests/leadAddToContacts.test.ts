import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const leadPage = read("src", "app", "(app)", "leads", "[id]", "page.tsx");
const leadActions = read("src", "app", "actions", "leads.ts");
const conversion = read("src", "lib", "leadToContact.ts");

test("lead detail offers Add to Contacts only for an unlinked lead with both permissions", () => {
  assert.match(
    leadPage,
    /!lead\.contactId[\s\S]+hasPermission\(user, "leads\.link_contact"\)[\s\S]+hasPermission\(user, "contacts\.create"\)/,
  );
  assert.match(leadPage, /action=\{addLeadToContacts\.bind\(null, lead\.id\)\}/);
  assert.match(leadPage, /AddLeadToContactsButton/);
});

test("Add to Contacts reauthorizes and passes accessible contacts to the converter", () => {
  assert.match(
    leadActions,
    /addLeadToContacts[\s\S]+requireLeadAccess\(leadId, "leads\.link_contact"\)[\s\S]+hasPermission\(user, "contacts\.create"\)/,
  );
  assert.match(leadActions, /getAccessibleContactIds\(user\)/);
  assert.match(
    leadActions,
    /addLeadToContactsAtomic\(\{[\s\S]+leadId,[\s\S]+userId: user\.id,[\s\S]+accessibleContactIds/,
  );
});

test("the converter explicitly scopes tenant reads and writes", () => {
  assert.match(conversion, /resolveActingTenant\(userId, tx\)/);
  assert.match(conversion, /where: \{ id: leadId, tenantId, deletedAt: null \}/);
  assert.match(conversion, /where: \{ tenantId, deletedAt: null, OR: matchers \}/);
  assert.match(conversion, /tenantId,[\s\S]+firstName:/);
  assert.match(
    conversion,
    /updateMany\(\{[\s\S]+id: leadId,[\s\S]+tenantId,[\s\S]+deletedAt: null,[\s\S]+contactId: null/,
  );
  assert.match(conversion, /matching_contact_unavailable/);
  assert.match(conversion, /ambiguous_contact_match/);
  assert.match(conversion, /linked\.count !== 1/);
});
