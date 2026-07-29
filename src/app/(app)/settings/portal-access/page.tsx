import { basePrisma, prisma } from "@/lib/db";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { requirePermission } from "@/lib/permissions";
import {
  grantPortalAccess,
  revokePortalAccess,
  reviewPortalProfileRequest,
} from "@/app/actions/portalAdmin";
import { contactName, formatDateTime } from "@/lib/format";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

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

type ProfileRequestRow = {
  id: string;
  contactId: string;
  contactName: string;
  changes: Record<string, unknown>;
  note: string | null;
  status: string;
  createdAt: Date;
};

function RoleSelect() {
  return <select name="role" className="input"><option value="viewer">Viewer</option><option value="manager">Manager</option><option value="owner">Owner</option></select>;
}

export default async function PortalAccessPage() {
  await requirePermission("portal_access.manage");
  const [contacts, fleets, grants, profileRequests] = await Promise.all([
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
    basePrisma.$queryRaw<ProfileRequestRow[]>`
      SELECT request."id", request."contactId",
        CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
          ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END AS "contactName",
        request."changes", request."note", request."status", request."createdAt"
      FROM "PortalProfileChangeRequest" request
      JOIN "Contact" contact ON contact."id" = request."contactId"
      WHERE request."status" = 'pending'
      ORDER BY request."createdAt" ASC
      LIMIT 200
    `,
  ]);
  const portalUsers = contacts.filter((contact) => contact.email);

  return <SettingsWorkspace
    current="portal-access"
    title="Customer portal administration"
    description="Manage delegated access and review customer profile-change requests."
    groups={SETTINGS_NAV_GROUPS}
  >

    {profileRequests.length > 0 && (
      <section className="space-y-3">
        <h2 className="font-semibold">Pending profile changes</h2>
        <div className="space-y-3">
          {profileRequests.map((request) => (
            <div key={request.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div><p className="font-medium">{request.contactName}</p><p className="text-xs text-muted-foreground">Submitted {formatDateTime(request.createdAt)}</p></div>
                <span className="badge bg-amber-500/15 text-amber-300">Pending</span>
              </div>
              <dl className="grid sm:grid-cols-2 gap-x-5 gap-y-2 text-sm">
                {Object.entries(request.changes).map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{key}</dt><dd>{value == null || value === "" ? "—" : String(value)}</dd></div>)}
              </dl>
              {request.note && <p className="text-sm text-muted-foreground">Customer note: {request.note}</p>}
              <div className="grid md:grid-cols-2 gap-3">
                <SaveForm success="Request reviewed" resetOnSuccess={false} action={reviewPortalProfileRequest.bind(null, request.id, "approved")} className="flex gap-2">
                  <input name="reviewNote" className="input" placeholder="Optional approval note" />
                  <SaveButton className="btn-primary">Approve & apply</SaveButton>
                </SaveForm>
                <SaveForm success="Request reviewed" resetOnSuccess={false} action={reviewPortalProfileRequest.bind(null, request.id, "rejected")} className="flex gap-2">
                  <input name="reviewNote" className="input" placeholder="Reason for rejection" required />
                  <SaveButton className="btn-secondary text-red-300">Reject</SaveButton>
                </SaveForm>
              </div>
            </div>
          ))}
        </div>
      </section>
    )}

    <section className="space-y-3">
      <h2 className="font-semibold">Delegated account and fleet access</h2>
      <div className="grid lg:grid-cols-2 gap-4">
        <SaveForm success="Portal access granted" action={grantPortalAccess} className="card space-y-3">
          <input type="hidden" name="targetType" value="contact" />
          <h3 className="font-semibold">Grant contact/account access</h3>
          <select name="viewerContactId" className="input" required><option value="">Portal user</option>{portalUsers.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)} · {contact.email}</option>)}</select>
          <select name="targetId" className="input" required><option value="">Contact or account to expose</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)}</option>)}</select>
          <div className="flex gap-2"><RoleSelect /><SaveButton className="btn-primary">Grant access</SaveButton></div>
        </SaveForm>

        <SaveForm success="Portal access granted" action={grantPortalAccess} className="card space-y-3">
          <input type="hidden" name="targetType" value="fleet" />
          <h3 className="font-semibold">Grant fleet access</h3>
          <select name="viewerContactId" className="input" required><option value="">Portal user</option>{portalUsers.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)} · {contact.email}</option>)}</select>
          <select name="targetId" className="input" required><option value="">Fleet to expose</option>{fleets.map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name}</option>)}</select>
          <div className="flex gap-2"><RoleSelect /><SaveButton className="btn-primary">Grant access</SaveButton></div>
        </SaveForm>
      </div>

      <ResponsiveEntityTable>
        <table className="table-base">
          <thead><tr><th>Portal user</th><th>Target</th><th>Role</th><th>Status</th><th>Granted</th><th></th></tr></thead>
          <tbody>
            {grants.length === 0 && <tr><td data-empty colSpan={6} className="text-center py-8 text-muted-foreground">No delegated portal access grants.</td></tr>}
            {grants.map((grant) => (
              <tr key={grant.id}>
                <td data-primary data-label="Portal user">{grant.viewerName}</td>
                <td data-label="Target">{grant.targetName}<p className="text-xs text-muted-foreground capitalize">{grant.targetType}</p></td>
                <td data-label="Role" className="capitalize">{grant.role}</td>
                <td data-label="Status"><span className={`badge ${grant.active ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground"}`}>{grant.active ? "Active" : "Revoked"}</span></td>
                <td data-label="Granted">{formatDateTime(grant.createdAt)}</td>
                <td data-actions>{grant.active && <SaveForm success="Portal access revoked" resetOnSuccess={false} action={revokePortalAccess.bind(null, grant.id)}><SaveButton className="text-red-400 text-sm">Revoke</SaveButton></SaveForm>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </section>
  </SettingsWorkspace>;
}
