import assert from "node:assert/strict";
import crypto from "node:crypto";

import { basePrisma } from "../src/lib/db";
import {
  addLeadToContactsAtomic,
  LeadToContactError,
} from "../src/lib/leadToContact";

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  assert.ok(
    process.env.NODE_ENV === "test" && dbName.endsWith("_test"),
    "lead-to-contact integration checks require the throwaway *_test database",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "");
  const tenantA = `ltc-tenant-a-${suffix}`;
  const tenantB = `ltc-tenant-b-${suffix}`;
  const userId = `ltc-user-${suffix}`;
  const stageId = `ltc-stage-${suffix}`;
  const emails = {
    hidden: `hidden-${suffix}@example.invalid`,
    cross: `cross-${suffix}@example.invalid`,
    reuse: `reuse-${suffix}@example.invalid`,
    concurrent: `concurrent-${suffix}@example.invalid`,
  };

  const leadIds = {
    hidden: `ltc-hidden-${suffix}`,
    cross: `ltc-cross-${suffix}`,
    reuse: `ltc-reuse-${suffix}`,
    concurrent: `ltc-concurrent-${suffix}`,
  };
  const hiddenContactId = `ltc-hidden-contact-${suffix}`;
  const crossTenantContactId = `ltc-cross-contact-${suffix}`;
  const reusableContactId = `ltc-reuse-contact-${suffix}`;

  try {
    await basePrisma.tenant.createMany({
      data: [
        { id: tenantA, name: "Lead conversion A", slug: `ltc-a-${suffix}` },
        { id: tenantB, name: "Lead conversion B", slug: `ltc-b-${suffix}` },
      ],
    });
    await basePrisma.user.create({
      data: {
        id: userId,
        name: "Lead conversion tester",
        email: `ltc-user-${suffix}@example.invalid`,
        passwordHash: "test-only",
      },
    });
    await basePrisma.tenantMember.create({
      data: { id: `ltc-member-${suffix}`, tenantId: tenantA, userId },
    });
    await basePrisma.pipelineStage.create({
      data: { id: stageId, tenantId: tenantA, name: "Lead conversion", order: 99_000 },
    });

    await basePrisma.contact.createMany({
      data: [
        {
          id: hiddenContactId,
          tenantId: tenantA,
          firstName: "Hidden",
          email: emails.hidden,
        },
        {
          id: crossTenantContactId,
          tenantId: tenantB,
          firstName: "Other tenant",
          email: emails.cross,
        },
        {
          id: reusableContactId,
          tenantId: tenantA,
          firstName: "Reusable",
          email: emails.reuse,
        },
      ],
    });
    await basePrisma.lead.createMany({
      data: [
        {
          id: leadIds.hidden,
          tenantId: tenantA,
          title: "Hidden match",
          name: "Hidden Match",
          email: emails.hidden,
          stageId,
          createdById: userId,
          assignedToId: userId,
        },
        {
          id: leadIds.cross,
          tenantId: tenantA,
          title: "Cross tenant match",
          name: "Cross Tenant Match",
          email: emails.cross,
          stageId,
          createdById: userId,
          assignedToId: userId,
        },
        {
          id: leadIds.reuse,
          tenantId: tenantA,
          title: "Reusable match",
          name: "Reusable Match",
          email: emails.reuse,
          stageId,
          createdById: userId,
          assignedToId: userId,
        },
        {
          id: leadIds.concurrent,
          tenantId: tenantA,
          title: "Concurrent conversion",
          name: "Concurrent Conversion",
          email: emails.concurrent,
          stageId,
          createdById: userId,
          assignedToId: userId,
        },
      ],
    });

    await assert.rejects(
      addLeadToContactsAtomic({
        leadId: leadIds.hidden,
        userId,
        accessibleContactIds: [],
      }),
      (error: unknown) =>
        error instanceof LeadToContactError &&
        error.code === "matching_contact_unavailable",
    );
    const hiddenLead = await basePrisma.lead.findUniqueOrThrow({
      where: { id: leadIds.hidden },
      select: { contactId: true },
    });
    assert.equal(hiddenLead.contactId, null, "an inaccessible match must not be linked");
    assert.equal(
      await basePrisma.contact.count({ where: { tenantId: tenantA, email: emails.hidden } }),
      1,
      "an inaccessible match must not cause a duplicate contact",
    );

    const cross = await addLeadToContactsAtomic({
      leadId: leadIds.cross,
      userId,
      accessibleContactIds: null,
    });
    assert.equal(cross.created, true, "a contact in another tenant is not a match");
    assert.notEqual(cross.contactId, crossTenantContactId);
    const crossCreated = await basePrisma.contact.findUniqueOrThrow({
      where: { id: cross.contactId },
      select: { tenantId: true },
    });
    assert.equal(crossCreated.tenantId, tenantA, "new contact is stamped with the acting tenant");

    const reused = await addLeadToContactsAtomic({
      leadId: leadIds.reuse,
      userId,
      accessibleContactIds: [reusableContactId],
    });
    assert.equal(reused.created, false);
    assert.equal(reused.contactId, reusableContactId, "one accessible tenant match is reused");

    const [first, second] = await Promise.all([
      addLeadToContactsAtomic({
        leadId: leadIds.concurrent,
        userId,
        accessibleContactIds: null,
      }),
      addLeadToContactsAtomic({
        leadId: leadIds.concurrent,
        userId,
        accessibleContactIds: null,
      }),
    ]);
    assert.equal(first.contactId, second.contactId, "concurrent submissions converge on one contact");
    assert.equal(
      [first, second].filter((result) => result.created).length,
      1,
      "only one concurrent submission creates the contact",
    );
    assert.equal(
      await basePrisma.contact.count({
        where: { tenantId: tenantA, email: emails.concurrent, deletedAt: null },
      }),
      1,
      "the lead row lock prevents duplicate contact creation",
    );

    console.log("Lead-to-contact integration checks passed.");
  } finally {
    await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(leadIds) } } });
    await basePrisma.contact.deleteMany({
      where: {
        OR: [
          { id: { in: [hiddenContactId, crossTenantContactId, reusableContactId] } },
          { email: { in: Object.values(emails) } },
        ],
      },
    });
    await basePrisma.pipelineStage.deleteMany({ where: { id: stageId } });
    await basePrisma.tenantMember.deleteMany({ where: { userId } });
    await basePrisma.user.deleteMany({ where: { id: userId } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await basePrisma.$disconnect();
  });
