"use client";

import { Printer } from "lucide-react";

export default function PrintPageButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="btn-primary print:hidden">
      <Printer className="size-4" /> {label}
    </button>
  );
}
