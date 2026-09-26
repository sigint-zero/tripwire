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
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-gray-400">
        {description}
      </p>
    </header>
  );
}
