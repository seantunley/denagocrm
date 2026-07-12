"use client";

import dynamic from "next/dynamic";

// Puck's editor is browser-only (drag-drop DOM); load it with no SSR.
const PuckDocEditor = dynamic(() => import("./PuckDocEditor"), {
  ssr: false,
  loading: () => <p className="text-xs text-muted-foreground">Loading the editor…</p>,
});

export default function PuckLoader() {
  return <PuckDocEditor />;
}
