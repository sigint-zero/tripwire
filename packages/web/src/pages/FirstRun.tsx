import { PageHeader } from "../components/PageHeader";

export function FirstRunPage() {
  return (
    <main className="mx-auto max-w-xl p-8 text-neutral-900">
      <PageHeader
        title="Set up Tripwire"
        description="Connect an RPC endpoint, add your first rule, and choose where alerts go."
      />
    </main>
  );
}
