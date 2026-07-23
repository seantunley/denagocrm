import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const leadPage = read("src", "app", "(app)", "leads", "[id]", "page.tsx");
const leadActions = read("src", "app", "actions", "leads.ts");

test("lead detail offers Add to Contacts only for an unlinked lead with both permissions", () => {
  assert.match(
    leadPage,
    /!lead\.contactId[\s\S]+hasPermission\(user, "leads\.link_contact"\)[\s\S]+hasPermission\(user, "contacts\.create"\)/,
  );
  assert.match(leadPage, /action=\{addLeadToContacts\.bind\(null, lead\.id\)\}/);
  assert.match(leadPage, /AddLeadToContactsButton/);
});

test("Add to Contacts reauthorizes, avoids an unambiguous duplicate, and links atomically", () => {
  assert.match(
    leadActions,
    /addLeadToContacts[\s\S]+requireLeadAccess\(leadId, "leads\.link_contact"\)[\s\S]+hasPermission\(user, "contacts\.create"\)/,
  );
  assert.match(leadActions, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(leadActions, /matches\.length === 1/);
  assert.match(leadActions, /tx\.contact\.create/);
  assert.match(leadActions, /tx\.lead\.update[\s\S]+data: \{ contactId \}/);
  assert.match(leadActions, /action: "lead\.contact_linked"/);
});
