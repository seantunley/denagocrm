export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type OfflineOperationType =
  | "lead.create"
  | "lead.update"
  | "contact.create"
  | "contact.update"
  | "jobcard.notes"
  | "jobcard.inspection"
  | "jobcard.photo"
  | "inspection.photo"
  | "delivery.complete"
  | "delivery.photo";

export type OfflineDescriptor = {
  type: OfflineOperationType;
  recordId?: string;
  parentId?: string;
  baseVersion?: string;
};

export type OfflineField =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "file"; value: Blob; fileName: string; contentType: string };

export type OfflineMutation = {
  id: string;
  tenantId: string;
  userId: string;
  operation: OfflineDescriptor;
  fields: OfflineField[];
  createdAt: number;
  attempts: number;
  status: "pending" | "syncing" | "failed" | "conflict";
  error?: string;
};

export type OfflineSnapshot = {
  tenantId: string;
  userId: string;
  capturedAt: number;
  leads: Array<{ id: string; title: string; name: string; email: string | null; phone: string | null; status: string; stage: string; updatedAt: string }>;
  contacts: Array<{ id: string; name: string; email: string | null; phone: string | null; whatsapp: string | null; updatedAt: string }>;
  jobCards: Array<{ id: string; number: number; status: string; description: string; customer: string; vehicle: string; checkinNotes: string | null; checkoutNotes: string | null; updatedAt: string }>;
  deliveries: Array<{ id: string; number: number; customer: string; scheduledFor: string | null; updatedAt: string }>;
};
