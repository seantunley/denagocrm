export default function PrintLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <div className="min-h-screen bg-white text-slate-900">{children}</div>;
}
