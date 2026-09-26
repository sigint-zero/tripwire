export function Stepper({
  steps,
  current,
  reachable,
  onSelect,
}: {
  steps: string[];
  current: number;
  reachable: (index: number) => boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex items-center">
      {steps.map((title, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={title} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              disabled={!reachable(i)}
              onClick={() => onSelect(i)}
              aria-current={active ? "step" : undefined}
              className="group flex items-center gap-3 disabled:cursor-not-allowed"
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center border font-mono text-xs font-bold transition-colors ${
                  done
                    ? "border-emerald-500 bg-emerald-500 text-black group-hover:bg-emerald-400"
                    : active
                      ? "border-emerald-400 bg-emerald-500/10 text-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.35)]"
                      : "border-white/15 text-gray-600"
                }`}
              >
                {done ? (
                  <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
                    <path
                      d="M3 8.5 L6.5 12 L13 4.5"
                      className="fill-none stroke-current stroke-[2.5]"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-xs font-bold tracking-[0.2em] uppercase ${active ? "inline" : "hidden xl:inline"} ${
                  active
                    ? "text-emerald-400"
                    : done
                      ? "text-gray-300 group-hover:text-emerald-400"
                      : "text-gray-600"
                }`}
              >
                {title}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={`mx-3 h-px min-w-4 flex-1 ${done ? "bg-emerald-500" : "bg-white/10"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
