import { ClipboardList, UserCircle2, LogOut } from "lucide-react";

const NAV_ITEMS = [
  { key: "pending", label: "Pending Signatures", icon: ClipboardList },
  { key: "profile", label: "Profile", icon: UserCircle2 },
];

// activePage: one of NAV_ITEMS keys, or "sign" for the detail screen
// (the Sign screen has no tab of its own — it's reached by clicking a
// row in Pending Signatures, and its back button returns to "pending").
export default function DoctorLayout({
  activePage,
  onNavigate,
  doctorName = "Doctor",
  onSignOut,
  children,
}) {
  return (
    <div className="min-h-screen bg-[#F5F6F4] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-14 max-w-5xl items-center justify-between gap-3 px-4 py-3 md:h-14 md:px-6 md:py-0">
          <span className="shrink-0 text-sm font-semibold tracking-tight text-slate-900">
            Referral Bridge
          </span>
          <div className="flex items-center gap-3">
            <span className="max-w-32 truncate text-sm text-slate-600 sm:max-w-none">
              {doctorName}
            </span>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>

        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 md:px-6">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
            const isActive = activePage === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNavigate(key)}
                className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-[#2F6F62] text-[#2F6F62]"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5 md:px-6 md:py-7">
        {children}
      </main>
    </div>
  );
}
