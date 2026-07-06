import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { mergeContacts } from "@/app/actions/merge";
import { contactName, formatDate } from "@/lib/format";

type C = Awaited<ReturnType<typeof getContacts>>[number];

function getContacts() {
  return prisma.contact.findMany({
    include: { _count: { select: { leads: true, vehicles: true, communications: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export default async function DuplicatesPage() {
  await requireUser();
  const contacts = await getContacts();

  // group by identical email or identical phone
  const groups = new Map<string, C[]>();
  const byKey = (key: string, c: C) => {
    const g = groups.get(key) ?? [];
    if (!g.some((x) => x.id === c.id)) g.push(c);
    groups.set(key, g);
  };
  for (const c of contacts) {
    if (c.email) byKey(`e:${c.email.toLowerCase()}`, c);
    if (c.phone) byKey(`p:${c.phone.replace(/\s+/g, "")}`, c);
  }
  const dupeGroups = [...groups.entries()]
    .filter(([, g]) => g.length > 1)
    .map(([key, g]) => ({ key, contacts: g }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Duplicate contacts</h1>
        <p className="text-sm text-slate-400 mt-1">
          Contacts sharing the same email or phone number. Choose which one to keep — all leads,
          vehicles, job cards and history move across, and the duplicates go to the Trash.
        </p>
      </div>

      {dupeGroups.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-slate-400">No duplicates found. 🎉</p>
        </div>
      ) : (
        dupeGroups.map((group) => (
          <div key={group.key} className="card">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Shared {group.key.startsWith("e:") ? "email" : "phone"}:{" "}
              <span className="text-slate-300 normal-case">{group.key.slice(2)}</span>
            </p>
            <ul className="divide-y divide-slate-800">
              {group.contacts.map((c) => (
                <li key={c.id} className="py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link href={`/contacts/${c.id}`} className="text-orange-400 hover:underline font-medium">
                      {contactName(c)}
                    </Link>
                    <p className="text-xs text-slate-400">
                      {[c.email, c.phone].filter(Boolean).join(" · ")} · added{" "}
                      {formatDate(c.createdAt)} · {c._count.leads} leads · {c._count.vehicles}{" "}
                      vehicles · {c._count.communications} comms
                    </p>
                  </div>
                  <form
                    action={mergeContacts.bind(
                      null,
                      c.id,
                      group.contacts.filter((x) => x.id !== c.id).map((x) => x.id).join(",")
                    )}
                  >
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
