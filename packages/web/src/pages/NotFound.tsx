import { Link } from "@tanstack/react-router";
import { ShellLayout } from "../components/AppShell";
import { PageHeader } from "../components/PageHeader";
import { buttonClass } from "../components/ui";

export function NotFoundPage() {
  return (
    <ShellLayout>
      <PageHeader
        title="Page not found"
        description="There is nothing at this address."
      />
      <Link to="/" className={buttonClass()}>
        Back to overview
      </Link>
    </ShellLayout>
  );
}
