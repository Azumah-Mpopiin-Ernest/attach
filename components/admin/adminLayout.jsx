import {
  LayoutDashboard,
  UploadCloud,
  Users,
  KeyRound,
  Search,
  LogOut,
} from "lucide-react";

const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "intake", label: "Intake", icon: UploadCloud },
  { key: "users", label: "Users", icon: Users },
  { key: "keys", label: "Registration Keys", icon: KeyRound },
  { key: "explorer", label: "Explorer", icon: Search },
];

// activePage: one of the NAV_ITEMS keys
// onNavigate: (key) => void
// adminName: string, shown in the top bar
export default function AdminLayout({
  activePage,
  onNavigate,
  adminName = "Admin",
  onSignOut,
  children,
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#F5F6F4] text-slate-900 md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full flex-none flex-col bg-[#16232A] text-slate-200 md:w-60">
        <div className="flex items-center justify-between px-4 py-4 md:block md:px-5 md:py-5">
          <span className="text-sm font-semibold tracking-tight text-white">
            Referral Bridge
          </span>
          <span className="block text-xs text-slate-400">Admin</span>
        </div>

        <nav className="mt-0 flex flex-1 gap-1 overflow-x-auto px-3 pb-2 md:mt-2 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
            const isActive = activePage === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNavigate(key)}
                className={`flex w-auto flex-none items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors md:w-full ${
                  isActive
                    ? "bg-white/10 text-white"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="h-4 w-4 flex-none" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-white/10 px-3 py-3 md:py-4">
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white"
          >
            <LogOut className="h-4 w-4 flex-none" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex min-h-14 flex-none items-center justify-end border-b border-slate-200 bg-white px-4 py-3 md:px-6 md:py-0">
          <div className="flex min-w-0 items-center gap-2 text-sm text-slate-600">
            <span className="rounded-full bg-[#2F6F62]/10 px-2 py-0.5 text-xs font-medium text-[#2F6F62]">
              Admin
            </span>
            <span className="truncate">{adminName}</span>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
