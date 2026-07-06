export default function PrintLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      {/* Paint the whole document white so the app's dark theme never frames the page */}
      <style>{`html, body { background:#ffffff !important; }`}</style>
      {children}
    </div>
  );
}
