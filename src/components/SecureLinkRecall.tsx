"use client";

import { recallSecureLink } from "@/app/actions/emails";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";

/** Recall one secure link. Asks first: it cannot be undone, only sent again. */
export default function SecureLinkRecall({ id, fileName }: { id: string; fileName: string }) {
  return (
    <ConfirmActionDialog
      trigger={<button type="button" className="btn-secondary btn-sm">Recall</button>}
      title={`Recall “${fileName}”?`}
      description="The link stops working straight away. Anyone who opens it is told the file was withdrawn. A copy somebody has already downloaded cannot be taken back, and this cannot be undone — to share the file again, send it again."
      confirmLabel="Recall link"
      destructive
      success="Recalled. The link no longer works."
      onConfirm={() => recallSecureLink(id)}
    />
  );
}
