import Link from "next/link";
import { ContactRound, ScanSearch } from "lucide-react";
import { prisma } from "@/lib/db";
import { mergeContacts } from "@/app/actions/merge";
import { contactName, formatDate } from "@/lib/format";
import { getAccessibleContactIds, requirePermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";
import ConfirmDelete from "@/components/ConfirmDelete";
import { emailKey } from "@/lib/contactMatch";
import { phoneTail } from "@/lib/phoneMatch";

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
  const automotiveOn = await isModuleEnabled("automotive");
  const ids = await getAccessibleContactIds(user);
  const contacts = await getContacts(ids);
  const groups = new Map<string, ContactRow[]>();
  const add = (key: string, contact: ContactRow) => {
    const group = groups.get(key) ?? [];
    if (!group.some((item) => item.id === contact.id)) group.push(contact);
    groups.set(key, group);
  };
  // The same identity rules as everywhere else (lib/contactMatch.ts): trimmed,
  // case-insensitive email; the phone's last digits, so "083 123 4567",
  // "+27 83 123 4567" and "0831234567" are one number. Stripping only spaces
  // missed every duplicate typed with a +27 or brackets.
  for (const contact of contacts) {
    const email = emailKey(contact.email);
    if (email) add(`e:${email}`, contact);
    const tail = phoneTail(contact.phone);
    if (tail) add(`p:${tail}`, contact);
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
              <span className="text-slate-300 normal-case">
                {group.key.startsWith("e:") ? group.key.slice(2) : group.contacts.find((c) => c.phone)?.phone ?? group.key.slice(2)}
              </span>
            </p>
            <ul className="divide-y divide-slate-800">
              {group.contacts.map((contact) => (
                <li key={contact.id} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link href={`/contacts/${contact.id}`} className="text-orange-400 hover:underline font-medium">{contactName(contact)}</Link>
                    <p className="text-xs text-slate-400">
                      {[contact.email, contact.phone].filter(Boolean).join(" · ")} · added {formatDate(contact.createdAt)} · {contact._count.leads} leads{automotiveOn ? ` · ${contact._count.vehicles} vehicles` : ""} · {contact._count.communications} comms
                    </p>
                  </div>
                  <ConfirmDelete
                    action={mergeContacts.bind(null, contact.id, group.contacts.filter((item) => item.id !== contact.id).map((item) => item.id).join(","))}
                    title={`Keep ${contactName(contact)} and merge ${group.contacts.length - 1} other${group.contacts.length > 2 ? "s" : ""} into it?`}
                    description={`${group.contacts
                      .filter((item) => item.id !== contact.id)
                      .map((item) => contactName(item))
                      .join(", ")} will be merged in: their leads, quotes, messages, vehicles, test drives and everything else move to ${contactName(contact)}, blank details are filled in from them, and they leave the contact list. A merge can't be undone.`}
                    trigger="Keep this one → merge others in"
                    triggerClass="btn-secondary btn-sm"
                    confirmLabel="Merge"
                    pendingLabel="Merging…"
                    success="Merged"
                    reasonLabel="Why are these the same person?"
                    reasonPlaceholder="Same customer entered twice"
                  />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
