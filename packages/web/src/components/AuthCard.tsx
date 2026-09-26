import type { FormEvent, ReactNode } from "react";
import { Wordmark } from "./Wordmark";

/** A centred form outside the navigation shell: login and first run. */
export function AuthCard({
  title,
  hint,
  onSubmit,
  children,
}: {
  title: string;
  hint?: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <form onSubmit={submit} className="w-full max-w-sm space-y-6">
        <Wordmark className="mb-10 block h-10" />
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tighter text-white uppercase">
            {title}
          </h1>
          {hint && <p className="mt-2 text-sm text-gray-400">{hint}</p>}
        </div>
        {children}
      </form>
    </main>
  );
}
