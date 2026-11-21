import { SaveForm, SaveButton } from "@/components/SaveForm";
import { setDocumentStaysWithVehicle } from "@/app/actions/vehicleDocuments";

/**
 * A vehicle document's "stays with the vehicle" switch (warranty-transfer-brief.md, PR 2). On: the next owner sees it
 * in their portal too (the service book, the warranty certificate). Off — the default — it stays the owner's of the
 * time it was added.
 */
export default function StaysWithVehicleToggle({ documentId, on, revalidate }: { documentId: string; on: boolean; revalidate: string }) {
  return (
    <SaveForm action={setDocumentStaysWithVehicle.bind(null, documentId, revalidate)} success={on ? "Stays with this owner" : "Stays with the vehicle"} resetOnSuccess={false}>
      <input type="hidden" name="on" value={on ? "" : "on"} />
      <SaveButton
        className={`shrink-0 text-xs ${on ? "text-emerald-400" : "text-muted-foreground"} hover:underline`}
        pendingLabel="Saving…"
        title={on ? "The next owner will see this document. Click to keep it with the owner of the time." : "Only the owner when it was added sees this. Click to let it pass to the next owner."}
      >
        {on ? "✓ Stays with the vehicle" : "Stays with the vehicle?"}
      </SaveButton>
    </SaveForm>
  );
}
