import Link from "next/link";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import ContactForm from "@/components/ContactForm";
import { createContact } from "@/app/actions/contacts";
import { contactName, formatDate } from "@/lib/format";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const AVATAR_COLORS = [
  "bg-orange-600", "bg-blue-600", "bg-emerald-600", "bg-violet-600",
  "bg-pink-600", "bg-amber-600", "bg-cyan-600", "bg-red-600",
];

function avatarColor(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const { q, view } = await searchParams;
  const cards = view !== "list";
  const where = q
    ? {
        OR: [
          { firstName: { contains: q } },
          { lastName: { contains: q } },
          { company: { contains: q } },
          { email: { contains: q } },
          { phone: { contains: q } },
        ],
      }
    : {};

  const [contacts, users] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        tags: true,
        owner: true,
        _count: {
          select: {
            vehicles: { where: { deletedAt: null } },
            leads: { where: { status: "open", deletedAt: null } },
          },
        },
      },
      take: 200,
    }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
  ]);

  const viewToggle = (target: string, label: string, active: boolean) => (
    <Link
      href={`/contacts?${new URLSearchParams({ ...(q ? { q } : {}), view: target })}`}
      className={active ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Contacts</h1>
          <div className="flex gap-1">
            {viewToggle("cards", "▦ Cards", cards)}
            {viewToggle("list", "☰ List", !cards)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <form className="flex gap-2">
            {!cards && <input type="hidden" name="view" value="list" />}
            <input
              name="q"
              className="input w-64"
              placeholder="Search name, email, phone…"
              defaultValue={q ?? ""}
            />
            <button className="btn-secondary">Search</button>
          </form>
          <ModalTrigger label="+ New contact" title="New contact">
            <ContactForm
              action={createContact}
              submitLabel="Create contact"
              users={users.map((u) => ({ id: u.id, name: u.name }))}
            />
          </ModalTrigger>
        </div>
      </div>

      {contacts.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-slate-400">
            {q ? "No contacts match your search." : "No contacts yet — add your first one."}
          </p>
        </div>
      )}

      {cards ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {contacts.map((c) => {
            const name = contactName(c);
            return (
              <Link
                key={c.id}
                href={`/contacts/${c.id}`}
                className="card hover:border-orange-600/60 transition-colors flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`h-10 w-10 shrink-0 rounded-full flex items-center justify-center text-sm font-bold text-white ${avatarColor(
                      name
                    )}`}
                  >
                    {initials(name)}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{name}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {c.isCompany ? "Company" : c.company || c.city || "—"}
                      {c.owner ? ` · ${c.owner.name}` : ""}
                    </p>
                  </div>
                </div>
                {(c.tags.length > 0 || c._count.vehicles > 0 || c._count.leads > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {c.tags.map((t) => (
                      <span key={t.id} className="badge text-white" style={{ backgroundColor: t.color }}>
                        {t.name}
                      </span>
                    ))}
                    {c._count.vehicles > 0 && (
                      <span className="badge bg-slate-800 text-slate-300">
                        ⚡ {c._count.vehicles} vehicle{c._count.vehicles > 1 ? "s" : ""}
                      </span>
                    )}
                    {c._count.leads > 0 && (
                      <span className="badge bg-blue-500/15 text-blue-300">
                        ◎ {c._count.leads} open lead{c._count.leads > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
                <div className="text-xs text-slate-400 space-y-0.5 mt-auto">
                  {c.email && <p className="truncate">✉️ {c.email}</p>}
                  {c.phone && <p>📞 {c.phone}</p>}
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Name</th>
                <th>Tags</th>
                <th>Email</th>
                <th>Phone</th>
                <th>City</th>
                <th>Vehicles</th>
                <th>Open leads</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/contacts/${c.id}`} className="font-medium text-orange-400 hover:underline">
                      {contactName(c)}
                    </Link>
                    {c.isCompany && (
                      <span className="badge bg-slate-800 text-slate-400 ml-2">Company</span>
                    )}
                  </td>
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      {c.tags.map((t) => (
                        <span key={t.id} className="badge text-white" style={{ backgroundColor: t.color }}>
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{c.email ?? "—"}</td>
                  <td>{c.phone ?? "—"}</td>
                  <td>{c.city ?? "—"}</td>
                  <td>{c._count.vehicles}</td>
                  <td>{c._count.leads}</td>
                  <td className="text-slate-400">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
