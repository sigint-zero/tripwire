export function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="mb-10">
      <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
        {title}
      </h1>
      <div className="mt-4 h-px w-full bg-linear-to-r from-emerald-500/50 to-transparent" />
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-gray-400">
        {description}
      </p>
    </header>
  );
}
