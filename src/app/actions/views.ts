"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";

export async function saveView(formData: FormData) {
  await requireCrm();
  const name = String(formData.get("name") ?? "").trim();
  const page = String(formData.get("page") ?? "").trim();
  const query = String(formData.get("query") ?? "").trim();
  if (!name || !page) return;
  await prisma.savedView.create({ data: { name, page, query } });
  revalidatePath(`/${page}/list`);
}

export async function deleteView(id: string, formData: FormData) {
  await requireCrm();
  void formData;
  const view = await prisma.savedView.delete({ where: { id } });
  revalidatePath(`/${view.page}/list`);
}
