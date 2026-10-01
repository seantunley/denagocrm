import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validPassword } from "../src/lib/passwordPolicy";

// Gap audit #25: a team member who forgot their password had no way back in.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const security = src("src/app/actions/security.ts");
const fn = security.slice(security.indexOf("export async function resetTeamMemberPassword("), security.indexOf("export async function setUserDisabled("));

test("owner only, own workspace only, never another owner or yourself", () => {
  assert.match(fn, /const owner = await requireOwner\(\);/);
  assert.match(fn, /if \(userId === owner\.id\) refuse\(/);
  assert.match(fn, /await assertManageableUser\(userId\);/, "membership of the acting workspace");
  assert.match(fn, /if \(target\.role === "owner"\) refuse\(/);
});

test("same password floor as everywhere else — one shared rule", () => {
  assert.match(fn, /if \(!validPassword\(password\)\) refuse\(/);
  for (const file of ["src/app/actions/settings.ts", "src/app/actions/tenants.ts", "src/app/actions/security.ts"]) {
    assert.doesNotMatch(src(file), /function validPassword\(/, `${file} must use lib/passwordPolicy`);
  }
  assert.equal(validPassword("short1"), false);
  assert.equal(validPassword("longenoughbutnodigits"), false);
  assert.equal(validPassword("longenough123"), true);
});

test("signed out everywhere, in the same transaction as the new password, and audited without it", () => {
  const tx = fn.slice(fn.indexOf("basePrisma.$transaction("));
  assert.match(tx, /tx\.user\.update\(\{ where: \{ id: userId \}, data: \{ passwordHash/);
  assert.match(tx, /UPDATE "User" SET "sessionVersion" = "sessionVersion" \+ 1 WHERE "id" = \$\{userId\}/);
  assert.match(tx, /action: "security\.password_reset_by_owner"/);
  assert.doesNotMatch(tx.slice(tx.indexOf("logAuditStrict(")), /password(Hash)?[,:}]/, "the audit line must not carry the password or its hash");
});

test("the button is on Team & access, for non-owners only", () => {
  const page = src("src/app/(app)/settings/access/page.tsx");
  assert.match(page, /user\.role !== "owner" && \(\s*<ModalTrigger label="Reset password"/);
  assert.match(page, /action=\{resetTeamMemberPassword\.bind\(null, user\.id\)\}/);
});
