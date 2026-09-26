import { Wordmark } from "../components/Wordmark";
import { PageHeader } from "../components/PageHeader";

export function FirstRunPage() {
  return (
    <main className="mx-auto max-w-xl px-8 py-16">
      <Wordmark className="mb-10 block h-10" />
      <PageHeader
        title="Set up Tripwire"
        description="Connect an RPC endpoint, add your first rule, and choose where alerts go."
      />
    </main>
  );
}
