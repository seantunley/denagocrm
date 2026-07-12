import { basePrisma, prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { grantPortalAccess, revokePortalAccess } from "@/app/actions/portalAdmin";
import { contactName, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type GrantRow = {
  id: string;
  viewerContactId: string;
  viewerName: string;
  targetName: string;
  targetType: string;
  role: string;
  active: boolean;
  createdAt: Date;
};

function RoleSelect() {
  return <select name="role" className="input"><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="owner">Owner</option></select>;
}

export default async function PortalAccessPage() {
  await requireOwner();
  const [contacts, fleets, grants] = await Promise.all([
    prisma.contact.findMany({ where: { deletedAt: null }, orderBy: [{ company: "asc" }, { firstName: "asc" }], take: 2000 }),
    prisma.fleet.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    basePrisma.$queryRaw<GrantRow[]>`
      SELECT g."id", g."viewerContactId",
        CASE WHEN viewer."isCompany" AND viewer."company" IS NOT NULL THEN viewer."company"
          ELSE TRIM(CONCAT(viewer."firstName", ' ', COALESCE(viewer."lastName", ''))) END AS "viewerName",
        CASE WHEN g."grantedContactId" IS NOT NULL
          THEN CASE WHEN target."isCompany" AND target."company" IS NOT NULL THEN target."company"
            ELSE TRIM(CONCAT(target."firstName", ' ', COALESCE(target."lastName", ''))) END
          ELSE fleet."name" END AS "targetName",
        CASE WHEN g."grantedContactId" IS NOT NULL THEN 'contact' ELSE 'fleet' END AS "targetType",
        g."role", g."active", g."createdAt"
      FROM "PortalAccessGrant" g
      JOIN "Contact" viewer ON viewer."id" = g."viewerContactId"
      LEFT JOIN "Contact" target ON target."id" = g."grantedContactId"
      LEFT JOIN "Fleet" fleet ON fleet."id" = g."fleetId"
      ORDER BY g."active" DESC, g."createdAt" DESC
    `,
  ]);
  const portalUsers = contacts.filter((contact) => contact.email);

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold">Customer portal access</h1><p className="text-sm text-slate-400 mt-1">Grant a signed-in contact access to another customer/account or to a fleet.</p></div>

    <div className="grid lg:grid-cols-2 gap-4">
      <form action={grantPortalAccess} className="card space-y-3">
        <input type="hidden" name="targetType" value="contact" />
        <h2 className="font-semibold">Grant contact/account access</h2>
        <select name="viewerContactId" className="input" required><option value="">Portal user</option>{portalUsers.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)} · {contact.email}</option>)}</select>
        <select name="targetId" className="input" required><option value="">Contact or account to expose</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)}</option>)}</select>
        <div className="flex gap-2"><RoleSelect /><button className="btn-primary">Grant access</button></div>
      </form>

      <form action={grantPortalAccess} className="card space-y-3">
        <input type="hidden" name="targetType" value="fleet" />
        <h2 className="font-semibold">Grant fleet access</h2>
        <select name="viewerContactId" className="input" required><option value="">Portal user</option>{portalUsers.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)} · {contact.email}</option>)}</select>
        <select name="targetId" className="input" required><option value="">Fleet to expose</option>{fleets.map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name}</option>)}</select>
        <div className="flex gap-2"><RoleSelect /><button className="btn-primary">Grant access</button></div>
      </form>
    </div>

    <div className="card p-0 overflow-x-auto"><table className="table-base"><thead><tr><th>Portal user</th><th>Target</th><th>Role</th><th>Status</th><th>Granted</th><th></th></tr></thead><tbody>{grants.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400">No delegated portal access grants.</td></tr>}{grants.map((grant) => <tr key={grant.id}><td>{grant.viewerName}</td><td>{grant.targetName}<p className="text-xs text-slate-500 capitalize">{grant.targetType}</p></td><td className="capitalize">{grant.role}</td><td><span className={`badge ${grant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-500"}`}>{grant.active ? "Active" : "Revoked"}</span></td><td>{formatDateTime(grant.createdAt)}</td><td>{grant.active && <form action={revokePortalAccess.bind(null, grant.id)}><button className="text-red-400 text-sm">Revoke</button></form>}</td></tr>)}</tbody></table></div>
  </div>;
}
