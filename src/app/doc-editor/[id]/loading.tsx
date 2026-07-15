import { PageSkeleton } from "@/components/visual-system";

export default function LoadingDocumentEditor() {
  return <div className="min-h-screen bg-background p-3"><PageSkeleton variant="builder" /></div>;
}
