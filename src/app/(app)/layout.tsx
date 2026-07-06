import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import Nav from "@/components/Nav";
import AppShell from "@/components/AppShell";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  const sidebar = (
    <>
      <div className="px-4 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/branding/denago-cape-town-logo.png"
          alt="Denago Cape Town CRM"
          className="h-8 w-auto object-contain"
        />
      </div>
      <div className="px-3 pb-2">
        <form action="/search">
          <input
            name="q"
            className="input py-1.5 text-xs"
            placeholder="🔍 Search everything…"
          />
        </form>
      </div>
      <div className="flex-1 px-3 overflow-y-auto">
        <Nav />
      </div>
      <div className="px-4 py-4 border-t border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-slate-300 font-medium truncate">{user.name}</p>
          <div className="flex items-center gap-1 shrink-0">
            <Link
              href="/trash"
              title="Trash"
              className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              🗑
            </Link>
            <Link
              href="/settings"
              title="Settings"
              className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              ⚙
            </Link>
          </div>
        </div>
        <form action={logout}>
          <button className="text-xs text-slate-500 hover:text-slate-300 mt-1 cursor-pointer">
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  return <AppShell sidebar={sidebar}>{children}</AppShell>;
}
