import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { contactName } from "../../format";
import { getAccessibleContactIds, getAccessibleDocumentIds, hasAnyPermission } from "../../permissions";
import { documentArgs } from "../../crmAssistantPlan";
import { ToolOutput, User, fuzzy, dateKey, refused } from "../lookupKit";

/** What's on file for one customer: titles, tags and dates — never the contents. */
export async function documents(user: User, raw: z.infer<typeof documentArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "documents.view_all", "documents.view_owned"))) return refused("documents");
  const { customer } = documentArgs.parse(raw);
  const contactIds = await getAccessibleContactIds(user);
  const looksLikeId = /^c[a-z0-9]{20,}$/i.test(customer);
  const contacts = await prisma.contact.findMany({
    where: {
      deletedAt: null,
      ...(contactIds === null ? {} : { id: { in: contactIds } }),
      ...(looksLikeId
        ? { OR: [{ id: customer }, { leads: { some: { id: customer } } }] }
        : { OR: [{ firstName: fuzzy(customer) }, { lastName: fuzzy(customer) }, { company: fuzzy(customer) }, { leads: { some: { OR: [{ name: fuzzy(customer) }, { title: fuzzy(customer) }] } } }] }),
    },
    take: 3,
    select: { id: true, firstName: true, lastName: true },
  });
  if (!contacts.length) return { truncated: false, rows: [], data: [{ note: `No customer you can see matches "${customer}".` }] };
  if (contacts.length > 1) {
    return { truncated: false, rows: [], data: [{ note: "Several customers match — ask which one.", candidates: contacts.map((c) => contactName(c)) }] };
  }
  const contact = contacts[0];
  const docIds = await getAccessibleDocumentIds(user);
  const docs = await prisma.document.findMany({
    where: {
      deletedAt: null,
      replacedById: null,
      ...(docIds === null ? {} : { id: { in: docIds } }),
      OR: [{ contactId: contact.id }, { vehicle: { contactId: contact.id } }],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, fileName: true, tag: true, mimeType: true, createdAt: true },
  });
  return {
    truncated: docs.length === 30,
    // documentId: what read_document reads a PDF by.
    data: [{ customer: contactName(contact), link: `/contacts/${contact.id}`, documents: docs.map((d) => ({ documentId: d.id, file: d.fileName, tag: d.tag, added: dateKey(d.createdAt) })) }],
    rows: [{ label: `${contactName(contact)} — documents`, detail: `${docs.length} on file`, href: `/contacts/${contact.id}` }],
  };
}
