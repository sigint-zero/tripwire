import { Link } from "@tanstack/react-router";
import { ShellLayout } from "../components/AppShell";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  return (
    <ShellLayout>
      <PageHeader
        title="Page not found"
        description="There is nothing at this address."
      />
      <Link
        to="/"
        className="inline-flex border border-emerald-500 bg-emerald-500/10 px-6 py-2 text-xs font-bold tracking-[0.2em] text-emerald-400 uppercase transition-colors hover:bg-emerald-500 hover:text-black"
      >
        Back to overview
      </Link>
    </ShellLayout>
  );
}
