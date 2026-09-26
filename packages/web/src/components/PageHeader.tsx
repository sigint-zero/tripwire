import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  /** A button or link set to the right of the title. */
  action?: ReactNode;
}) {
  return (
    <header className="mb-10 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-gray-400">
          {description}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
