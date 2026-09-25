import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";

const areas = [
  { to: "/", label: "Overview" },
  { to: "/contracts", label: "Contracts" },
  { to: "/invariants", label: "Invariants" },
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
    <div className="flex min-h-screen bg-white text-neutral-900">
      <nav className="w-56 shrink-0 border-r border-neutral-200 p-4">
        <div className="mb-6 px-2 text-lg font-semibold">Tripwire</div>
        <ul className="space-y-1">
          {areas.map((area) => (
            <li key={area.to}>
              <Link
                to={area.to}
                activeOptions={{
                  exact: area.to === "/",
                  includeSearch: false,
                }}
                className="block rounded px-2 py-1.5 text-sm hover:bg-neutral-100"
                activeProps={{
                  className: "bg-neutral-100 font-medium text-neutral-900",
                }}
                inactiveProps={{ className: "text-neutral-600" }}
              >
                {area.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
