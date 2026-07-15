import Link from "next/link";
import { ContactRound, ScanSearch } from "lucide-react";
import { prisma } from "@/lib/db";
import { mergeContacts } from "@/app/actions/merge";
import { contactName, formatDate } from "@/lib/format";
import { getAccessibleContactIds, requirePermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";

type ContactRow = Awaited<ReturnType<typeof getContacts>>[number];

function getContacts(ids: string[] | null = null) {
  return prisma.contact.findMany({
    where: ids === null ? {} : { id: { in: ids } },
    include: { _count: { select: { leads: true, vehicles: true, communications: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export default async function DuplicatesPage() {
  const user = await requirePermission("contacts.merge");
  const ids = await getAccessibleContactIds(user);
  const contacts = await getContacts(ids);
  const groups = new Map<string, ContactRow[]>();
  const add = (key: string, contact: ContactRow) => {
    const group = groups.get(key) ?? [];
    if (!group.some((item) => item.id === contact.id)) group.push(contact);
    groups.set(key, group);
  };
  for (const contact of contacts) {
    if (contact.email) add(`e:${contact.email.toLowerCase()}`, contact);
    if (contact.phone) add(`p:${contact.phone.replace(/\s+/g, "")}`, contact);
  }
  const duplicateGroups = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, contacts: group }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Duplicate contacts"
        description={`${duplicateGroups.length} possible duplicate group${duplicateGroups.length === 1 ? "" : "s"} found across the contacts you can access.`}
      />

      {duplicateGroups.length === 0 ? (
        <EmptyState
          icon={ScanSearch}
          title="No duplicate contacts found"
          description="Accessible contacts currently have distinct email addresses and phone numbers. This check updates as customer data changes."
          action={<Link href="/contacts" className="btn-secondary"><ContactRound className="size-4" />Return to contacts</Link>}
        />
      ) : (
        duplicateGroups.map((group) => (
          <div key={group.key} className="card">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Shared {group.key.startsWith("e:") ? "email" : "phone"}:{" "}
              <span className="text-slate-300 normal-case">{group.key.slice(2)}</span>
            </p>
            <ul className="divide-y divide-slate-800">
              {group.contacts.map((contact) => (
                <li key={contact.id} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link href={`/contacts/${contact.id}`} className="text-orange-400 hover:underline font-medium">{contactName(contact)}</Link>
                    <p className="text-xs text-slate-400">
                      {[contact.email, contact.phone].filter(Boolean).join(" · ")} · added {formatDate(contact.createdAt)} · {contact._count.leads} leads · {contact._count.vehicles} vehicles · {contact._count.communications} comms
                    </p>
                  </div>
                  <form action={mergeContacts.bind(null, contact.id, group.contacts.filter((item) => item.id !== contact.id).map((item) => item.id).join(","))}>
                    <button className="btn-secondary btn-sm">Keep this one → merge others in</button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
