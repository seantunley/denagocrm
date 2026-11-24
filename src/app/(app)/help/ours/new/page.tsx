import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import GuideForm from "@/components/help/GuideForm";

export const metadata: Metadata = { title: "New guide · Help" };

export default async function NewGuidePage() {
  await requireTenantOwner();
  return (
    <div className="space-y-6">
      <Link href="/help/ours" className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Our own guides
      </Link>
      <PageHeader title="New guide" description="Everyone in the workspace can read it as soon as you add it." />
      <GuideForm />
    </div>
  );
}
