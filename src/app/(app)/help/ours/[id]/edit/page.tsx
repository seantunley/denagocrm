import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import GuideForm from "@/components/help/GuideForm";
import { isGuideId } from "@/lib/help/customGuides";
import { loadCustomGuides } from "@/lib/help/customGuidesStore";

export const metadata: Metadata = { title: "Edit guide · Help" };

export default async function EditGuidePage({ params }: { params: Promise<{ id: string }> }) {
  await requireTenantOwner();
  const { id } = await params;
  if (!isGuideId(id)) notFound();
  const guide = (await loadCustomGuides()).find((item) => item.id === id);
  if (!guide) notFound();
  return (
    <div className="space-y-6">
      <Link href={`/help/ours/${guide.id}`} className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Back to the guide
      </Link>
      <PageHeader title="Edit guide" description={guide.title} />
      <GuideForm guide={guide} />
    </div>
  );
}
