"use client";

import { useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  File,
  ExternalLink,
  Settings2,
  History,
} from "lucide-react";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { renameDocument, moveDocument, replaceDocument } from "@/app/actions/documents";
import RecordContextMenu from "@/components/RecordContextMenu";

export type RepoDoc = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeKB: number;
  tag: string | null;
  createdAt: string;
  filedOn: string | null;
  superseded: boolean;
  uploadedBy: string;
};

export type MoveTargets = {
  contacts: { id: string; label: string }[];
  vehicles: { id: string; label: string }[];
  quotes: { id: string; label: string }[];
};

const TAGS = ["", "invoice", "pop", "delivery-note", "delivery-photo", "delivery-signature", "checkin", "other"];

const input =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

export default function RepoRow({
  doc,
  targets,
  canManage = true,
}: {
  doc: RepoDoc;
  targets: MoveTargets;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = doc.mimeType.startsWith("image/")
    ? ImageIcon
    : doc.mimeType.includes("pdf")
      ? FileText
      : File;

  return (
    <RecordContextMenu
      label={doc.fileName}
      href={`/api/files/${doc.id}`}
      openInNewTab
    >
    <li className="flex items-center gap-3 py-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[13px] font-medium text-foreground">
          <a
            href={`/api/files/${doc.id}`}
            target="_blank"
            rel="noreferrer"
            className="truncate hover:text-primary"
            title="Open / preview"
          >
            {doc.fileName}
          </a>
          {doc.superseded && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <History className="size-3" />
              old version
            </span>
          )}
          {doc.tag && (
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {doc.tag}
            </span>
          )}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {doc.filedOn ?? "Unfiled"} · {doc.sizeKB} KB · {doc.createdAt} · {doc.uploadedBy}
        </p>
      </div>
      <a
        href={`/api/files/${doc.id}`}
        target="_blank"
        rel="noreferrer"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Open / preview"
      >
        <ExternalLink className="size-4" />
      </a>
      {canManage && !doc.superseded && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Settings2 className="size-3.5" />
          Manage
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">Manage — {doc.fileName}</DialogTitle>
          </DialogHeader>

          <form action={renameDocument.bind(null, doc.id)} className="space-y-2">
            <label className="block text-xs font-medium text-muted-foreground">Name & tag</label>
            <div className="flex gap-2">
              <input name="fileName" defaultValue={doc.fileName} className={input} required />
              <select name="tag" defaultValue={doc.tag ?? ""} className={`${input} !w-40`}>
                {TAGS.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag || "— no tag —"}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" type="submit">Save</Button>
          </form>

          <form action={moveDocument.bind(null, doc.id)} className="space-y-2 border-t border-border pt-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Move to a different record
            </label>
            <select name="target" className={input} defaultValue="">
              <option value="" disabled>Choose destination…</option>
              <optgroup label="Customers">
                {targets.contacts.map((contact) => (
                  <option key={contact.id} value={`contact:${contact.id}`}>{contact.label}</option>
                ))}
              </optgroup>
              <optgroup label="Vehicles">
                {targets.vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={`vehicle:${vehicle.id}`}>{vehicle.label}</option>
                ))}
              </optgroup>
              <optgroup label="Quotes">
                {targets.quotes.map((quote) => (
                  <option key={quote.id} value={`quote:${quote.id}`}>{quote.label}</option>
                ))}
              </optgroup>
            </select>
            <Button size="sm" variant="outline" type="submit">Move</Button>
          </form>

          <form action={replaceDocument.bind(null, doc.id)} className="space-y-2 border-t border-border pt-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Upload a new version (this one is kept in history)
            </label>
            <input type="file" name="file" required className="block w-full text-xs text-muted-foreground" />
            <Button size="sm" variant="outline" type="submit">Replace</Button>
          </form>
        </ResponsiveDialogContent>
      </Dialog>
    </li>
    </RecordContextMenu>
  );
}
