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
      <Link to="/" className="text-sm underline">
        Back to overview
      </Link>
    </ShellLayout>
  );
}
