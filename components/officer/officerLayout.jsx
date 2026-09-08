import { ClipboardList, LogOut } from "lucide-react";

export default function OfficerLayout({ officerName, onSignOut, children }) {
  return (
    <div className="min-h-screen bg-[#F5F6F4] text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-14 max-w-6xl items-center justify-between gap-3 px-4 py-3 md:h-14 md:px-6 md:py-0">
          <div className="flex min-w-0 items-center gap-2">
            <ClipboardList className="h-5 w-5 text-[#2F6F62]" />
            <span className="text-sm font-semibold">Referral Bridge</span>
            <span className="text-xs text-slate-400">Officer</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="max-w-32 truncate text-sm text-slate-600 sm:max-w-none">
              {officerName}
            </span>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5 md:px-6 md:py-7">
        {children}
      </main>
    </div>
  );
}
