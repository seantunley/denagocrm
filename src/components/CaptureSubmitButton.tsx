"use client";

import { CarFront, LoaderCircle, PackagePlus, Shapes, Wrench } from "lucide-react";
import { useFormStatus } from "react-dom";

import { useSavePending } from "@/components/SaveForm";

export type CaptureKind = "stock" | "vehicle" | "part" | "product";

const icons = {
  stock: PackagePlus,
  vehicle: CarFront,
  part: Wrench,
  product: Shapes,
};

const pendingLabels = {
  stock: "Adding stock unit…",
  vehicle: "Registering vehicle…",
  part: "Adding part…",
  product: "Creating product…",
};

export default function CaptureSubmitButton({ label, kind }: { label: string; kind: CaptureKind }) {
  // useFormStatus only reports for a <form action={…}>. Inside a SaveForm the
  // submit goes through onSubmit instead, so the pending state comes from its
  // context — which defaults to false for the still-unconverted callers.
  const { pending: formPending } = useFormStatus();
  const savePending = useSavePending();
  const pending = formPending || savePending;
  const Icon = icons[kind];
  const pendingLabel = label.toLowerCase().includes("save") ? "Saving changes…" : pendingLabels[kind];

  return (
    <button type="submit" disabled={pending} className="btn-primary min-h-10 w-full gap-2 sm:w-auto sm:min-w-40">
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {pending ? pendingLabel : label}
    </button>
  );
}
