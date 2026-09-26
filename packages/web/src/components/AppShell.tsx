import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ServerStatus } from "./ServerStatus";
import { Wordmark } from "./Wordmark";

const areas = [
  { to: "/", label: "Overview" },
  { to: "/contracts", label: "Contracts" },
  { to: "/rules", label: "Rules" },
  { to: "/violations", label: "Violations" },
  { to: "/responses", label: "Responses" },
  { to: "/activity", label: "Activity" },
  { to: "/notifications", label: "Notifications" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppShell() {
  return (
    <ShellLayout>
      <Outlet />
    </ShellLayout>
  );
}

export function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <nav className="flex w-60 shrink-0 flex-col border-r border-emerald-500/20 bg-panel p-4">
        <Link to="/" className="mb-8 block px-3 pt-2">
          <Wordmark className="h-7" />
        </Link>
        <ul className="space-y-1">
          {areas.map((area) => (
            <li key={area.to}>
              <Link
                to={area.to}
                activeOptions={{
                  exact: area.to === "/",
                  includeSearch: false,
                }}
                className="block border-l-2 px-3 py-2 text-xs font-bold tracking-[0.2em] uppercase transition-colors"
                activeProps={{
                  className:
                    "border-emerald-500 bg-emerald-500/5 text-emerald-400",
                }}
                inactiveProps={{
                  className:
                    "border-transparent text-gray-500 hover:bg-emerald-500/5 hover:text-emerald-400",
                }}
              >
                {area.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-auto border-t border-emerald-500/10 pt-4">
          <ServerStatus />
        </div>
      </nav>
      <main className="flex-1 px-10 py-10">{children}</main>
    </div>
  );
}
