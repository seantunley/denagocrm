import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  getAccessibleCaseIds,
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  getUserPermissionList,
  hasPermission,
  type PermissionUser,
} from "../src/lib/permissions";
import { getAccessibleActivityIds } from "../src/lib/activityAccess";

const prisma = new PrismaClient();

function expectContains(ids: string[] | null, expected: string, label: string) {
  assert.notEqual(ids, null, `${label}: scoped role must not receive unrestricted access`);
  assert.equal(ids?.includes(expected), true, `${label}: expected ${expected} to be accessible`);
}

function expectExcludes(ids: string[] | null, unexpected: string, label: string) {
  assert.notEqual(ids, null, `${label}: scoped role must not receive unrestricted access`);
  assert.equal(ids?.includes(unexpected), false, `${label}: ${unexpected} must not be accessible`);
}

async function main() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const ids = {
    salesUser: `rbac-sales-${suffix}`,
    teammate: `rbac-team-${suffix}`,
    outsider: `rbac-outside-${suffix}`,
    team: `rbac-team-row-${suffix}`,
    stage: `rbac-stage-${suffix}`,
    contactOwn: `rbac-contact-own-${suffix}`,
    contactTeam: `rbac-contact-team-${suffix}`,
    contactOutside: `rbac-contact-outside-${suffix}`,
    leadOwn: `rbac-lead-own-${suffix}`,
    leadTeam: `rbac-lead-team-${suffix}`,
    leadOutside: `rbac-lead-outside-${suffix}`,
    quoteOwn: `rbac-quote-own-${suffix}`,
    quoteTeam: `rbac-quote-team-${suffix}`,
    quoteOutside: `rbac-quote-outside-${suffix}`,
    vehicleOwn: `rbac-vehicle-own-${suffix}`,
    vehicleTeam: `rbac-vehicle-team-${suffix}`,
    vehicleOutside: `rbac-vehicle-outside-${suffix}`,
    jobOwn: `rbac-job-own-${suffix}`,
    jobTeam: `rbac-job-team-${suffix}`,
    jobOutside: `rbac-job-outside-${suffix}`,
    documentOwn: `rbac-document-own-${suffix}`,
    documentTeam: `rbac-document-team-${suffix}`,
    documentOutside: `rbac-document-outside-${suffix}`,
    caseOwn: `rbac-case-own-${suffix}`,
    caseTeam: `rbac-case-team-${suffix}`,
    caseOutside: `rbac-case-outside-${suffix}`,
    activityOwn: `rbac-activity-own-${suffix}`,
    activityTeam: `rbac-activity-team-${suffix}`,
    activityOutside: `rbac-activity-outside-${suffix}`,
  };
  const baseNumber = Math.floor(Date.now() / 1000) % 1_000_000_000;

  await prisma.user.createMany({
    data: [
      { id: ids.salesUser, name: "Scoped Sales", email: `${ids.salesUser}@example.invalid`, passwordHash: "test", role: "member", modules: "crm" },
      { id: ids.teammate, name: "Team Mate", email: `${ids.teammate}@example.invalid`, passwordHash: "test", role: "member", modules: "crm" },
      { id: ids.outsider, name: "Outside User", email: `${ids.outsider}@example.invalid`, passwordHash: "test", role: "member", modules: "crm" },
    ],
  });

  try {
    // The scoped user needs view_owned across ALL tested domains. role_sales_rep
    // covers leads/contacts/quotes/documents/cases/activities; role_technician adds
    // the workshop domains (vehicles/jobcards) — both are scoped roles with NO
    // view_all, so this exercises own/team/outside scoping across every domain
    // without granting any production role extra privileges.
    await prisma.$executeRaw`
      INSERT INTO "UserRole" ("id", "userId", "roleId") VALUES
        (gen_random_uuid()::text, ${ids.salesUser}, 'role_sales_rep'),
        (gen_random_uuid()::text, ${ids.salesUser}, 'role_technician'),
        (gen_random_uuid()::text, ${ids.teammate}, 'role_sales_rep'),
        (gen_random_uuid()::text, ${ids.teammate}, 'role_technician'),
        (gen_random_uuid()::text, ${ids.outsider}, 'role_sales_rep'),
        (gen_random_uuid()::text, ${ids.outsider}, 'role_technician')
    `;
    await prisma.$executeRaw`
      INSERT INTO "Team" ("id", "name", "active", "managerId")
      VALUES (${ids.team}, ${`RBAC team ${suffix}`}, true, ${ids.salesUser})
    `;
    await prisma.$executeRaw`
      INSERT INTO "TeamMember" ("id", "teamId", "userId", "isManager") VALUES
        (${`rbac-membership-a-${suffix}`}, ${ids.team}, ${ids.salesUser}, true),
        (${`rbac-membership-b-${suffix}`}, ${ids.team}, ${ids.teammate}, false)
    `;
    await prisma.$executeRaw`
      INSERT INTO "PipelineStage" (
        "id", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed"
      ) VALUES (
        ${ids.stage}, ${`RBAC stage ${suffix}`}, 900000, '#64748b',
        'pipeline_default_retail', 10, false
      )
    `;

    await prisma.contact.createMany({
      data: [
        { id: ids.contactOwn, firstName: "Own Contact", ownerId: ids.salesUser, createdById: ids.salesUser },
        { id: ids.contactTeam, firstName: "Team Contact", ownerId: ids.teammate, createdById: ids.teammate },
        { id: ids.contactOutside, firstName: "Outside Contact", ownerId: ids.outsider, createdById: ids.outsider },
      ],
    });

    await prisma.lead.createMany({
      data: [
        { id: ids.leadOwn, title: "Own lead", name: "Own Contact", stageId: ids.stage, contactId: ids.contactOwn, assignedToId: ids.salesUser, createdById: ids.salesUser },
        { id: ids.leadTeam, title: "Team lead", name: "Team Contact", stageId: ids.stage, contactId: ids.contactTeam, assignedToId: ids.teammate, createdById: ids.teammate },
        { id: ids.leadOutside, title: "Outside lead", name: "Outside Contact", stageId: ids.stage, contactId: ids.contactOutside, assignedToId: ids.outsider, createdById: ids.outsider },
      ],
    });
    await prisma.$executeRaw`UPDATE "Lead" SET "teamId" = ${ids.team} WHERE "id" = ${ids.leadTeam}`;

    await prisma.quote.createMany({
      data: [
        { id: ids.quoteOwn, number: baseNumber, contactId: ids.contactOwn, leadId: ids.leadOwn, createdById: ids.salesUser },
        { id: ids.quoteTeam, number: baseNumber + 1, contactId: ids.contactTeam, leadId: ids.leadTeam, createdById: ids.teammate },
        { id: ids.quoteOutside, number: baseNumber + 2, contactId: ids.contactOutside, leadId: ids.leadOutside, createdById: ids.outsider },
      ],
    });

    await prisma.vehicle.createMany({
      data: [
        { id: ids.vehicleOwn, model: "Own cart", contactId: ids.contactOwn },
        { id: ids.vehicleTeam, model: "Team cart", contactId: ids.contactTeam },
        { id: ids.vehicleOutside, model: "Outside cart", contactId: ids.contactOutside },
      ],
    });

    await prisma.jobCard.createMany({
      data: [
        { id: ids.jobOwn, number: baseNumber + 10, description: "Own service", vehicleId: ids.vehicleOwn, contactId: ids.contactOwn, technicianId: ids.salesUser },
        { id: ids.jobTeam, number: baseNumber + 11, description: "Team service", vehicleId: ids.vehicleTeam, contactId: ids.contactTeam, technicianId: ids.teammate },
        { id: ids.jobOutside, number: baseNumber + 12, description: "Outside service", vehicleId: ids.vehicleOutside, contactId: ids.contactOutside, technicianId: ids.outsider },
      ],
    });

    await prisma.document.createMany({
      data: [
        { id: ids.documentOwn, fileName: "own.pdf", storedName: `${ids.documentOwn}.pdf`, mimeType: "application/pdf", sizeBytes: 1, contactId: ids.contactOwn, quoteId: ids.quoteOwn, uploadedById: ids.salesUser },
        { id: ids.documentTeam, fileName: "team.pdf", storedName: `${ids.documentTeam}.pdf`, mimeType: "application/pdf", sizeBytes: 1, vehicleId: ids.vehicleTeam, jobCardId: ids.jobTeam, uploadedById: ids.teammate },
        { id: ids.documentOutside, fileName: "outside.pdf", storedName: `${ids.documentOutside}.pdf`, mimeType: "application/pdf", sizeBytes: 1, contactId: ids.contactOutside, uploadedById: ids.outsider },
      ],
    });

    await prisma.activity.createMany({
      data: [
        { id: ids.activityOwn, summary: "Own follow-up", dueDate: new Date(), leadId: ids.leadOwn, assignedToId: ids.salesUser, createdById: ids.salesUser },
        { id: ids.activityTeam, summary: "Team follow-up", dueDate: new Date(), contactId: ids.contactTeam, assignedToId: ids.teammate, createdById: ids.teammate },
        { id: ids.activityOutside, summary: "Outside follow-up", dueDate: new Date(), contactId: ids.contactOutside, assignedToId: ids.outsider, createdById: ids.outsider },
      ],
    });

    await prisma.$executeRaw`
      INSERT INTO "CustomerCase" ("id", "contactId", "vehicleId", "type", "subject", "description") VALUES
        (${ids.caseOwn}, ${ids.contactOwn}, ${ids.vehicleOwn}, 'support', 'Own case', 'Own case details'),
        (${ids.caseTeam}, ${ids.contactTeam}, ${ids.vehicleTeam}, 'support', 'Team case', 'Team case details'),
        (${ids.caseOutside}, ${ids.contactOutside}, ${ids.vehicleOutside}, 'support', 'Outside case', 'Outside case details')
    `;

    const scopedUser: PermissionUser = {
      id: ids.salesUser,
      name: "Scoped Sales",
      email: `${ids.salesUser}@example.invalid`,
      role: "member",
      // modules is retired; RBAC is the only authorization input now.
    };

    assert.equal(await hasPermission(scopedUser, "contacts.view_owned"), true);
    assert.equal(await hasPermission(scopedUser, "contacts.view_all"), false);
    assert.equal(await hasPermission(scopedUser, "quotes.edit"), true);
    assert.equal(await hasPermission(scopedUser, "document_templates.manage"), false);
    const permissionList = await getUserPermissionList(scopedUser);
    assert.equal(permissionList.includes("contacts.view_owned"), true);
    assert.equal(permissionList.includes("vehicles.view_owned"), true);

    const scopes = {
      leads: await getAccessibleLeadIds(scopedUser),
      contacts: await getAccessibleContactIds(scopedUser),
      quotes: await getAccessibleQuoteIds(scopedUser),
      vehicles: await getAccessibleVehicleIds(scopedUser),
      jobCards: await getAccessibleJobCardIds(scopedUser),
      documents: await getAccessibleDocumentIds(scopedUser),
      cases: await getAccessibleCaseIds(scopedUser),
      activities: await getAccessibleActivityIds(scopedUser),
    };

    for (const [label, accessible, own, team, outside] of [
      ["leads", scopes.leads, ids.leadOwn, ids.leadTeam, ids.leadOutside],
      ["contacts", scopes.contacts, ids.contactOwn, ids.contactTeam, ids.contactOutside],
      ["quotes", scopes.quotes, ids.quoteOwn, ids.quoteTeam, ids.quoteOutside],
      ["vehicles", scopes.vehicles, ids.vehicleOwn, ids.vehicleTeam, ids.vehicleOutside],
      ["job cards", scopes.jobCards, ids.jobOwn, ids.jobTeam, ids.jobOutside],
      ["documents", scopes.documents, ids.documentOwn, ids.documentTeam, ids.documentOutside],
      ["cases", scopes.cases, ids.caseOwn, ids.caseTeam, ids.caseOutside],
      ["activities", scopes.activities, ids.activityOwn, ids.activityTeam, ids.activityOutside],
    ] as const) {
      expectContains(accessible, own, label);
      expectContains(accessible, team, label);
      expectExcludes(accessible, outside, label);
    }

    console.log("Platform-wide RBAC integration tests passed.");
  } finally {
    await prisma.$executeRaw`DELETE FROM "CustomerCase" WHERE "id" IN (${ids.caseOwn}, ${ids.caseTeam}, ${ids.caseOutside})`;
    await prisma.activity.deleteMany({ where: { id: { in: [ids.activityOwn, ids.activityTeam, ids.activityOutside] } } });
    await prisma.document.deleteMany({ where: { id: { in: [ids.documentOwn, ids.documentTeam, ids.documentOutside] } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: [ids.jobOwn, ids.jobTeam, ids.jobOutside] } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: [ids.vehicleOwn, ids.vehicleTeam, ids.vehicleOutside] } } });
    await prisma.quote.deleteMany({ where: { id: { in: [ids.quoteOwn, ids.quoteTeam, ids.quoteOutside] } } });
    await prisma.lead.deleteMany({ where: { id: { in: [ids.leadOwn, ids.leadTeam, ids.leadOutside] } } });
    await prisma.contact.deleteMany({ where: { id: { in: [ids.contactOwn, ids.contactTeam, ids.contactOutside] } } });
    await prisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${ids.stage}`;
    await prisma.$executeRaw`DELETE FROM "TeamMember" WHERE "teamId" = ${ids.team}`;
    await prisma.$executeRaw`DELETE FROM "Team" WHERE "id" = ${ids.team}`;
    await prisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${ids.salesUser}, ${ids.teammate}, ${ids.outsider})`;
    await prisma.user.deleteMany({ where: { id: { in: [ids.salesUser, ids.teammate, ids.outsider] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
