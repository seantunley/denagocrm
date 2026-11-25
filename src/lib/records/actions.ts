/**
 * The contextual actions a record drawer can offer (wave 2, W2-02). A registry of
 * DESCRIPTORS only: each one names the existing server action that does the work,
 * so the drawer adds no new way to change a record. That action re-checks the
 * workspace, the person's access and the record's state on every call — what is
 * declared here only decides what is OFFERED, never what is allowed.
 *
 * Pure. The server works out which are available for one person on one record
 * (`availableActions`); the drawer renders each by its id.
 */
import type { RecordType } from "./ref";

export type ActionId = "contact" | "schedule" | "completeActivity" | "changeStage" | "assignOwner";

export type ActionDescriptor = {
  id: ActionId;
  label: string;
  appliesTo: readonly RecordType[];
  /** Any one of these. Mirrors the backing action's own check, so nobody is offered a refusal. */
  permissions: readonly string[];
  /** The existing server action(s) that do the work — named so a test can hold the two together. */
  backedBy: readonly string[];
  /** Asks before doing it. A message is never sent without the person pressing Send, whatever this says. */
  confirm: boolean;
};

/** contacts.edit / leads.edit: what addCommunication and sendEmailAction require (CUSTOMER_RECORD_WRITE_PERMISSIONS). */
const RECORD_WRITE = ["contacts.edit", "leads.edit"] as const;

export const RECORD_ACTIONS: readonly ActionDescriptor[] = [
  {
    id: "contact",
    label: "Log a call or send a message",
    appliesTo: ["lead"],
    permissions: [...RECORD_WRITE, "inbox.reply"],
    backedBy: ["addCommunication", "sendWhatsAppMessage", "sendEmailAction", "scheduleFollowUp"],
    confirm: false,
  },
  { id: "schedule", label: "Book the next step", appliesTo: ["lead"], permissions: ["activities.manage"], backedBy: ["scheduleFollowUp"], confirm: false },
  { id: "completeActivity", label: "Mark done", appliesTo: ["lead"], permissions: ["activities.manage"], backedBy: ["completeActivity"], confirm: false },
  { id: "changeStage", label: "Move stage", appliesTo: ["lead"], permissions: ["leads.change_stage"], backedBy: ["moveLead"], confirm: false },
  { id: "assignOwner", label: "Change owner", appliesTo: ["lead"], permissions: ["leads.assign"], backedBy: ["assignLead"], confirm: false },
];

/** The actions this person may be offered on a record of this type, given the permissions they hold. */
export function availableActions(type: RecordType, has: (permission: string) => boolean): ActionId[] {
  return RECORD_ACTIONS.filter((action) => action.appliesTo.includes(type) && action.permissions.some(has)).map((action) => action.id);
}
