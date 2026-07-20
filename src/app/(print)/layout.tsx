import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";

export default async function PrintLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Print docs live outside the (app) layout, so guard module-owned pages
  // (e.g. automotive job-card / warranty prints) here too.
  await assertPathModuleEnabled();
  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      {/* Paint the whole document white so the app's dark theme never frames the page */}
      <style>{`html, body { background:#ffffff !important; }`}</style>
      {children}
    </div>
  );
}
