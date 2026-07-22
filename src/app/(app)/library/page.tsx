import Link from "next/link";
import { Download, FileStack, FileText, FolderOpen, Layers3, Plus, Upload } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import { deleteLibraryDocument } from "@/app/actions/library";
import { AddDocumentsForm, NewVersionForm } from "@/components/LibraryUploader";
import { formatDateTime } from "@/lib/format";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type DocWithVersions = Awaited<ReturnType<typeof getDocuments>>[number];

function getDocuments() {
  return prisma.libraryDocument.findMany({
    orderBy: { name: "asc" },
    include: {
      versions: { orderBy: { version: "desc" }, include: { uploadedBy: true } },
    },
  });
}

function DocumentCard({ doc }: { doc: DocWithVersions }) {
  const latest = doc.versions[0];
  return (
    <Surface className="group p-4 transition hover:border-primary/30">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
          <FileText className="size-5" />
        </span>
        <div className="flex-1 min-w-48">
          <p className="font-semibold">
            {doc.name}{" "}
            <StatusPill className="ml-1" tone="info">v{latest?.version ?? 0} · latest</StatusPill>
          </p>
          <p className="text-xs text-muted-foreground">
            {doc.category ?? "Document"} · {latest ? humanSize(latest.sizeBytes) : ""} · updated{" "}
            {formatDateTime(doc.updatedAt)}
            {latest ? ` by ${latest.uploadedBy.name}` : ""}
          </p>
        </div>
        {latest && (
          <a href={`/api/library/${latest.id}`} className="btn-primary btn-sm">
            <Download className="size-3.5" />Download latest
          </a>
        )}
        <ModalTrigger
          label={<><Upload className="size-3.5" />New version</>}
          title={`New version of ${doc.name}`}
          buttonClass="btn-secondary btn-sm"
        >
          <NewVersionForm documentId={doc.id} nextVersion={(latest?.version ?? 0) + 1} />
        </ModalTrigger>
        <ConfirmDelete
          action={deleteLibraryDocument.bind(null, doc.id)}
          title={`Delete “${doc.name}”?`}
          description="The document and all its versions move to the Trash for 60 days."
          trigger="Remove"
          triggerClass="text-xs text-muted-foreground hover:text-red-500 cursor-pointer"
        />
      </div>

      {doc.versions.length > 1 && (
        <details className="mt-3">
          <summary className="text-xs font-medium text-primary cursor-pointer hover:underline">
            Version history ({doc.versions.length})
          </summary>
          <ul className="mt-2 divide-y divide-border/50">
            {doc.versions.map((v) => (
              <li key={v.id} className="py-2 flex items-center gap-3 text-sm">
                <span
                  className={`badge ${
                    v.id === doc.versions[0]?.id
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  v{v.version}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="truncate">{v.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {humanSize(v.sizeBytes)} · {formatDateTime(v.createdAt)} · {v.uploadedBy.name}
                    {v.note ? ` — ${v.note}` : ""}
                  </p>
                </div>
                <a href={`/api/library/${v.id}`} className="btn-secondary btn-sm" aria-label={`Download version ${v.version}`}>
                  <Download className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Surface>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams?: Promise<{ cat?: string }>;
}) {
  await requireUser();
  const { cat } = (await searchParams) ?? {};
  const documents = await getDocuments();

  const categories = [...new Set(documents.map((d) => d.category ?? "Other"))].sort();
  const active = cat && categories.includes(cat) ? cat : null;
  const visible = active ? documents.filter((d) => (d.category ?? "Other") === active) : documents;

  // group by category when showing everything
  const groups = active
    ? [{ category: active, docs: visible }]
    : categories.map((c) => ({
        category: c,
        docs: documents.filter((d) => (d.category ?? "Other") === c),
      }));
  const totalVersions = documents.reduce((sum, doc) => sum + doc.versions.length, 0);
  const totalBytes = documents.reduce(
    (sum, doc) => sum + (doc.versions[0]?.sizeBytes ?? 0),
    0
  );

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={FolderOpen}
        eyebrow="Documents & data"
        title="Document library"
        description="Brochures, price lists and spec sheets — versioned so the team always shares the latest approved file."
        stats={[
          { label: "Documents", value: documents.length, icon: FileText },
          { label: "Categories", value: categories.length, icon: FolderOpen },
          { label: "Versions", value: totalVersions, icon: Layers3 },
          { label: "Latest files", value: humanSize(totalBytes), icon: FileStack },
        ]}
        actions={<ModalTrigger label={<><Plus className="size-4" />Add documents</>} title="Add documents to library">
          <AddDocumentsForm />
        </ModalTrigger>}
      />

      {documents.length > 0 && (
        <Surface className="flex gap-2 overflow-x-auto p-2">
          <Link href="/library" className={!active ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
            All ({documents.length})
          </Link>
          {categories.map((c) => (
            <Link
              key={c}
              href={`/library?cat=${encodeURIComponent(c)}`}
              className={active === c ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
            >
              {c} ({documents.filter((d) => (d.category ?? "Other") === c).length})
            </Link>
          ))}
        </Surface>
      )}

      {documents.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title="Build a trusted document library"
          description="Upload the first brochure, price list or specification sheet. New versions stay grouped so staff never send an outdated file."
          action={<ModalTrigger label={<><Plus className="size-4" />Add first document</>} title="Add documents to library"><AddDocumentsForm /></ModalTrigger>}
        />
      ) : (
        groups.map(
          (g) =>
            g.docs.length > 0 && (
              <section key={g.category} className="space-y-3">
                <SectionHeading title={g.category} description={`${g.docs.length} approved ${g.docs.length === 1 ? "document" : "documents"}`} />
                {g.docs.map((doc) => (
                  <DocumentCard key={doc.id} doc={doc} />
                ))}
              </section>
            )
        )
      )}
    </div>
  );
}
