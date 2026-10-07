import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/*
 * Sean, 2026-10-07: mail a person writes shows them on the From line —
 * "Sean Tunley · Denago Cape Town" — on the workspace's own address, so it still
 * passes SPF/DKIM. Replies reach them through Reply-To (#532), as before.
 */
Module.prototype.require = new Proxy(Module.prototype.require, {
  apply(target, self, args: [string]) {
    return args[0] === "server-only" ? {} : Reflect.apply(target, self, args);
  },
});
const { personFrom } = createRequire(import.meta.url)("../src/lib/email.ts") as typeof import("../src/lib/email");

test("the person's name in front of the workspace's, on the workspace's address", () => {
  assert.deepEqual(personFrom("Denago Cape Town <crm@denagocpt.co.za>", "Sean Tunley"), { name: "Sean Tunley · Denago Cape Town", address: "crm@denagocpt.co.za" });
  assert.deepEqual(personFrom('"Denago Cape Town" <crm@denagocpt.co.za>', "Sean Tunley"), { name: "Sean Tunley · Denago Cape Town", address: "crm@denagocpt.co.za" });
  assert.deepEqual(personFrom("crm@denagocpt.co.za", "Sean Tunley"), { name: "Sean Tunley", address: "crm@denagocpt.co.za" }, "no workspace name to add");
});

test("a name can't break out of the display name or add a header", () => {
  const sneaky = personFrom("Denago <crm@denagocpt.co.za>", 'Eve"\r\nBcc: x@evil.test <a@b>');
  assert.ok(sneaky);
  assert.doesNotMatch(sneaky.name, /[\r\n"<>]/);
  assert.equal(sneaky.address, "crm@denagocpt.co.za", "the address is never the person's");
  assert.equal(personFrom("Denago <crm@denagocpt.co.za>", "x".repeat(200))?.name.length, 60 + " · Denago".length);
});

test("nothing to add, or nothing safe to parse → the workspace's From, unchanged", () => {
  assert.equal(personFrom("Denago <crm@denagocpt.co.za>", "   "), null);
  assert.equal(personFrom("Denago Cape Town", "Sean Tunley"), null, "no address in SMTP_FROM: the existing fallback stands");
});

test("only mail a person writes carries it — the composer, a quote they email, a help-desk reply", () => {
  const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(code("src/lib/email.ts"), /from: \(input\.senderName && personFrom\(workspaceFrom, input\.senderName\)\) \|\| workspaceFrom,/);
  assert.match(code("src/app/actions/emails.ts"), /senderName: user\.name,/);
  assert.match(code("src/app/actions/quoteEmail.ts"), /senderName: user\.name,/);
  assert.match(code("src/app/actions/helpdesk.ts"), /emailTicketReply\(item, replyId, body, user\.id, user\.name\)/);
  // Automatic mail stays the workspace's own.
  for (const rel of ["src/lib/serviceReminders.ts", "src/lib/journeyStepExecutor.ts", "src/lib/signing/dispatch.ts", "src/lib/campaigns.ts"]) {
    assert.doesNotMatch(code(rel), /senderName/, rel);
  }
});
