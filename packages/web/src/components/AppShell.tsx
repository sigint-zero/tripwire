import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AccountMenu } from "./AccountMenu";
import { ChainBadge } from "./ChainBadge";
import { LockedKeyBanner } from "./LockedKeyBanner";
import { ServerStatus } from "./ServerStatus";
import { Wordmark } from "./Wordmark";

// Grouped: what is watched, what happened, and how Tripwire is set up.
const groups = [
  [
    { to: "/", label: "Overview" },
    { to: "/contracts", label: "Contracts" },
    { to: "/rules", label: "Rules" },
  ],
  [
    { to: "/violations", label: "Violations" },
    { to: "/responses", label: "Responses" },
    { to: "/activity", label: "Activity" },
  ],
  [
    { to: "/notifications", label: "Notifications" },
    { to: "/settings", label: "Settings" },
  ],
] as const;

const navigationIcons: Record<
  (typeof groups)[number][number]["to"],
  ReactNode
> = {
  "/": <path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z" />,
  "/contracts": (
    <path d="m10 2 7 4v8l-7 4-7-4V6l7-4Zm0 8 7-4M10 10 3 6m7 4v8" />
  ),
  "/rules": <path d="m3 5 1.5 1.5L7 4m3 1h7M3 11h3m4 0h7M3 16h3m4 0h7" />,
  "/violations": (
    <>
      <path d="m10 3 8 14H2L10 3Zm0 5v4" />
      <path d="M10 14.5v.1" strokeWidth="2" />
    </>
  ),
  "/responses": <path d="m11 2-8 10h6l-1 6 9-11h-6l1-5Z" />,
  "/activity": <path d="M2 10h4l2-6 4 12 2-6h4" />,
  "/notifications": <path d="M4 14h12l-2-3V7a4 4 0 0 0-8 0v4l-2 3Zm4 3h4" />,
  "/settings": (
    <>
      <path d="M3 6h3m4 0h7M3 14h7m4 0h3" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="12" cy="14" r="2" />
    </>
  ),
};

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
        <Link
          to="/"
          className="mb-8 block border-l-2 border-transparent px-3 pt-4"
        >
          <Wordmark />
          <span className="mt-2 block text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
            by <span className="text-gray-400">SigIntZero</span>
          </span>
        </Link>
        <div className="space-y-6">
          {groups.map((areas) => (
            <ul key={areas[0].to} className="space-y-1">
              {areas.map((area) => (
                <li key={area.to}>
                  <Link
                    to={area.to}
                    activeOptions={{
                      exact: area.to === "/",
                      includeSearch: false,
                    }}
                    className="group flex items-center gap-3 border-l-2 px-3 py-2.5 text-xs font-bold tracking-[0.2em] uppercase transition-colors"
                    activeProps={{
                      className:
                        "border-emerald-500 bg-emerald-500/5 text-emerald-400",
                    }}
                    inactiveProps={{
                      className:
                        "border-transparent text-gray-500 hover:bg-emerald-500/5 hover:text-emerald-400",
                    }}
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="square"
                      strokeMiterlimit={3}
                      aria-hidden="true"
                      className="size-4 shrink-0 opacity-70 transition-opacity group-hover:opacity-100 group-data-[status=active]:opacity-100"
                    >
                      {navigationIcons[area.to]}
                    </svg>
                    {area.label}
                  </Link>
                </li>
              ))}
            </ul>
          ))}
        </div>
        <div className="mt-auto border-t border-emerald-500/10 pt-4">
          <ServerStatus />
        </div>
      </nav>
      <main className="flex-1 px-10 pt-5 pb-10">
        <header className="mb-5 flex h-9 justify-end gap-2">
          <ChainBadge />
          <AccountMenu />
        </header>
        <LockedKeyBanner />
        {children}
      </main>
    </div>
  );
}
